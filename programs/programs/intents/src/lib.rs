//! intents: sell SOL on Solana, receive native ETH on Base Sepolia.
//!
//! A user escrows SOL in an `Intent` and runs a linear Dutch auction on the
//! ETH they want back. A solver fills by taking the SOL and having SODA sign a
//! Base payout from the pool PDA's derived address, which holds every solver's
//! inventory. The program tracks that inventory in each `Solver` ledger and
//! hands out the pool's Base nonces in order, so the SOL and an irrevocable
//! payout signature change hands in one Solana transaction.
//!
//! RFQ-lite (NEAR Intents style, `rfq.rs`): users keep SOL in a `UserVault`,
//! sign a canonical message off-chain, and the solver whose quote won submits
//! `execute_signed_intent`, which writes the same Filled `Intent` as `fill`.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke_signed};
use anchor_lang::system_program;
use solana_program::keccak;
// Re-exported from solana-secp256k1-recover, already in Cargo.lock; using the
// crate directly would re-resolve the committed lockfile.
#[allow(deprecated)]
use solana_program::secp256k1_recover::secp256k1_recover;

pub mod eth_rlp;
pub mod rfq;

pub use rfq::SignedIntentArgs;
#[allow(deprecated)]
use solana_program::sysvar::instructions::{
    load_instruction_at_checked, ID as INSTRUCTIONS_SYSVAR_ID,
};

declare_id!("BV9KfzKwXPp9hQZEyhoVm9STbDy7gCGCmKcKpCDr8jXA");

pub const SODA_PROGRAM_ID: Pubkey = pubkey!("CPAEfBXpMMsUrjLNhDYxaCH79DYvFHJFC27fttnxAL1J");
pub const SODA_COMMITTEE: Pubkey = pubkey!("9mX3oHUmsrYvzXjCo35HhfXufrGZT3hjsLoC74xbA6SS");
/// Phase 2 (`credit_solver_from_claim`) reads claims owned by this program.
pub const WITNESS_PROGRAM_ID: Pubkey = pubkey!("5v97wLYgMzyfQfpZWGQ6uPXTHh4JsJitUXPReYy2uuTp");

pub const CHAIN_ID: u64 = 84_532; // Base Sepolia
pub const GAS_LIMIT: u64 = 21_000; // plain ETH transfer, empty calldata
pub const EVM_CHAIN_TAG: [u8; 32] = *b"evm\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0";
/// soda `request_signature` instruction discriminator.
pub const REQUEST_SIGNATURE_DISC: [u8; 8] = [0x19, 0xe1, 0x70, 0x4a, 0x52, 0x5e, 0xb9, 0x1d];
/// soda `SigRequest` account discriminator.
pub const SIG_REQUEST_DISC: [u8; 8] = [0x36, 0x17, 0xd2, 0x80, 0x7b, 0xe9, 0xf1, 0xe9];
/// soda_witness `Claim` account discriminator, sha256("account:Claim")[..8].
pub const CLAIM_DISC: [u8; 8] = [155, 70, 22, 176, 123, 215, 246, 102];
/// soda_witness `Claim` size: discriminator + 147 bytes of Borsh (HANDOVER §4.2).
pub const CLAIM_LEN: usize = 155;
pub const CLAIM_STATUS_RECORDED: u8 = 1;
/// Chainlink's production keystone forwarder, which checks f+1 DON signatures.
/// Any other forwarder (the simulation mock) accepts reports from anyone.
pub const PRODUCTION_FORWARDER_ID: Pubkey = pubkey!("CXsKEJcs25TQEYU2e5jZ8QTPE3ffMLZhH6BWHrdcCCB5");
/// soda_witness `Config`: disc 8, admin 32, forwarder_program 32, forwarder_state 32,
/// workflow_owner 20, workflow_name 10, bump 1.
pub const WITNESS_CONFIG_LEN: usize = 135;
/// Prefix of the message `deposit_from` signs in `register_solver`.
pub const DEPOSIT_PROOF_TAG: &[u8; 16] = b"intents register";
pub const DEPOSIT_PROOF_LEN: usize = 16 + 32 + 32;

pub const MAX_SIG_REQUESTS: usize = 4; // the payout plus up to 3 gas bumps
pub const ANYONE_CAN_BUMP_AFTER: i64 = 60;
pub const CLOSE_FILLED_AFTER: i64 = 600;
/// The committee never signs a SigRequest after its expires_at. One left
/// unsigned this long past it (margin for clock skew) can never produce a
/// transaction, so a bump may reuse its slot once all four are taken.
pub const DEAD_SIG_REQUEST_AFTER: i64 = 60;

pub const STATUS_OPEN: u8 = 0;
pub const STATUS_FILLED: u8 = 1;
pub const STATUS_CANCELLED: u8 = 2;

#[program]
pub mod intents {
    use super::*;

    pub fn init_config(
        ctx: Context<InitConfig>,
        pool_evm_addr: [u8; 20],
        max_gas_price: u64,
        l1_fee_buffer_wei: u64,
        min_gas_price: u64,
    ) -> Result<()> {
        require!(
            min_gas_price > 0 && min_gas_price <= max_gas_price,
            IntentsError::BadGasConfig
        );
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.pool_bump = ctx.bumps.pool;
        config.pool_evm_addr = pool_evm_addr;
        config.next_nonce = 0;
        config.max_gas_price = max_gas_price;
        config.l1_fee_buffer_wei = l1_fee_buffer_wei;
        config.paused = false;
        config.witness_program = WITNESS_PROGRAM_ID;
        config.min_gas_price = min_gas_price;
        Ok(())
    }

    /// `deposit_sig` is an EIP-191 personal_sign by `deposit_from` over
    /// `deposit_proof_message(authority)`. Credits trust `deposit_from`, so
    /// nobody may claim an address they cannot sign for.
    pub fn register_solver(
        ctx: Context<RegisterSolver>,
        payout_addr: [u8; 20],
        deposit_from: [u8; 20],
        deposit_sig: [u8; 65],
    ) -> Result<()> {
        let msg = deposit_proof_message(&ctx.accounts.authority.key());
        require!(
            recover_evm_signer(&msg, &deposit_sig) == Some(deposit_from),
            IntentsError::DepositFromNotProven
        );
        let solver = &mut ctx.accounts.solver;
        solver.authority = ctx.accounts.authority.key();
        solver.payout_addr = payout_addr;
        solver.deposit_from = deposit_from;
        solver.balance_wei = 0;
        solver.fills = 0;
        solver.bump = ctx.bumps.solver;
        Ok(())
    }

    /// Trusted: the admin has checked the solver's deposit `tx_hash` to
    /// `pool_evm_addr` on Basescan. Writes the same `Credit` as
    /// `credit_solver_from_claim`, so a deposit credits once by either path.
    /// An amount of 0 only marks a deposit credited before the marker existed.
    pub fn credit_solver(
        ctx: Context<CreditSolver>,
        amount_wei: u128,
        tx_hash: [u8; 32],
    ) -> Result<()> {
        let solver = &mut ctx.accounts.solver;
        solver.balance_wei = solver
            .balance_wei
            .checked_add(amount_wei)
            .ok_or(IntentsError::MathOverflow)?;

        let credit = &mut ctx.accounts.credit;
        credit.solver = solver.authority;
        credit.claim = Pubkey::default();
        credit.tx_hash = tx_hash;
        credit.amount_wei = amount_wei;
        credit.credited_at = Clock::get()?.unix_timestamp;
        credit.bump = ctx.bumps.credit;
        emit!(SolverCredited {
            solver: solver.authority,
            amount_wei,
            balance_wei: solver.balance_wei,
        });
        Ok(())
    }

    /// Phase 2: credit a deposit that soda_witness recorded. This program
    /// judges the claim's facts itself. Anyone may submit once the witness takes
    /// reports only from the production forwarder with a pinned workflow owner;
    /// until then anyone can forge a claim, so the admin must co-sign. The
    /// `Credit` PDA is keyed by the deposit's tx hash, so a deposit credits once
    /// even when two solvers share a `deposit_from` and each opened a claim.
    pub fn credit_solver_from_claim(
        ctx: Context<CreditSolverFromClaim>,
        tx_hash: [u8; 32],
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, IntentsError::Paused);
        if !witness_trusted(&ctx.accounts.witness_config.try_borrow_data()?) {
            require!(
                ctx.accounts.admin.as_ref().map(|a| a.key()) == Some(config.admin),
                IntentsError::UntrustedWitness
            );
        }
        let claim_info = &ctx.accounts.claim;
        require_keys_eq!(
            *claim_info.owner,
            config.witness_program,
            IntentsError::ClaimNotFromWitness
        );
        let claim = WitnessClaim::parse(&claim_info.try_borrow_data()?)?;
        require!(claim.tx_hash == tx_hash, IntentsError::ClaimTxHashMismatch);
        check_claim(&claim, &config.pool_evm_addr, &ctx.accounts.solver)?;

        let solver = &mut ctx.accounts.solver;
        solver.balance_wei = solver
            .balance_wei
            .checked_add(claim.value_wei)
            .ok_or(IntentsError::MathOverflow)?;

        let credit = &mut ctx.accounts.credit;
        credit.solver = solver.authority;
        credit.claim = claim_info.key();
        credit.tx_hash = tx_hash;
        credit.amount_wei = claim.value_wei;
        credit.credited_at = Clock::get()?.unix_timestamp;
        credit.bump = ctx.bumps.credit;

        emit!(SolverCreditedFromClaim {
            solver: solver.authority,
            claim: claim_info.key(),
            tx_hash,
            amount_wei: claim.value_wei,
            balance_wei: solver.balance_wei,
        });
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn open_intent(
        ctx: Context<OpenIntent>,
        intent_id: u64,
        in_lamports: u64,
        recipient: [u8; 20],
        start_out_wei: u128,
        min_out_wei: u128,
        auction_duration: u32,
        expires_at: i64,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, IntentsError::Paused);
        let now = Clock::get()?.unix_timestamp;
        require!(
            in_lamports > 0
                && min_out_wei > 0
                && start_out_wei >= min_out_wei
                && recipient != [0u8; 20]
                && expires_at > now.saturating_add(auction_duration as i64),
            IntentsError::BadAuctionParams
        );

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: ctx.accounts.intent.to_account_info(),
                },
            ),
            in_lamports,
        )?;

        let intent = &mut ctx.accounts.intent;
        intent.user = ctx.accounts.user.key();
        intent.intent_id = intent_id;
        intent.in_lamports = in_lamports;
        intent.recipient = recipient;
        intent.start_out_wei = start_out_wei;
        intent.min_out_wei = min_out_wei;
        intent.auction_start = now;
        intent.auction_duration = auction_duration;
        intent.expires_at = expires_at;
        intent.status = STATUS_OPEN;
        intent.bump = ctx.bumps.intent;

        emit!(IntentOpened {
            intent: intent.key(),
            user: intent.user,
            intent_id,
            in_lamports,
            recipient,
            start_out_wei,
            min_out_wei,
            auction_start: now,
            auction_duration,
            expires_at,
        });
        Ok(())
    }

    /// Maker cancel: any time before a fill. The account stays so the page can
    /// show the refund; `close_intent` reclaims its rent.
    pub fn cancel_intent(ctx: Context<CancelIntent>) -> Result<()> {
        let intent = &mut ctx.accounts.intent;
        require!(intent.status == STATUS_OPEN, IntentsError::IntentNotOpen);
        move_lamports(
            &intent.to_account_info(),
            &ctx.accounts.user.to_account_info(),
            intent.in_lamports,
        )?;
        intent.status = STATUS_CANCELLED;
        emit!(IntentCancelled {
            intent: intent.key(),
            user: intent.user,
            refunded_lamports: intent.in_lamports,
        });
        Ok(())
    }

    /// The user closes a Cancelled intent. A Filled one holds the only state
    /// that can re-sign its payout (`bump_gas`), so only the admin closes it,
    /// after checking on Basescan that the payout landed. Rent goes to the user.
    pub fn close_intent(ctx: Context<CloseIntent>) -> Result<()> {
        let intent = &ctx.accounts.intent;
        let closer = ctx.accounts.closer.key();
        let now = Clock::get()?.unix_timestamp;
        let closable = (intent.status == STATUS_CANCELLED && closer == intent.user)
            || (intent.status == STATUS_FILLED
                && closer == ctx.accounts.config.admin
                && now > intent.filled_at.saturating_add(CLOSE_FILLED_AFTER));
        require!(closable, IntentsError::NotClosable);
        Ok(())
    }

    pub fn fill(
        ctx: Context<Fill>,
        expected_nonce: u64,
        out_wei: u128,
        gas_price: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let config = &ctx.accounts.config;
        let intent = &ctx.accounts.intent;

        require!(!config.paused, IntentsError::Paused);
        require!(intent.status == STATUS_OPEN, IntentsError::IntentNotOpen);
        require!(now < intent.expires_at, IntentsError::IntentExpired);
        let required = required_out(
            intent.start_out_wei,
            intent.min_out_wei,
            intent.auction_start,
            intent.auction_duration,
            now,
        )
        .ok_or(IntentsError::MathOverflow)?;
        require!(out_wei >= required, IntentsError::BelowRequiredOut);
        check_gas_price(config, gas_price)?;
        require!(expected_nonce == config.next_nonce, IntentsError::NonceMoved);

        let cost = payout_cost(out_wei, gas_price, config.l1_fee_buffer_wei)?;
        let solver = &mut ctx.accounts.solver;
        require!(solver.balance_wei >= cost, IntentsError::InsufficientSolverBalance);
        solver.balance_wei -= cost;
        solver.fills = solver.fills.saturating_add(1);

        let nonce = config.next_nonce;
        ctx.accounts.config.next_nonce = nonce.checked_add(1).ok_or(IntentsError::MathOverflow)?;

        let recipient = ctx.accounts.intent.recipient;
        let (unsigned_rlp, payload) = build_payout(nonce, gas_price, &recipient, out_wei);
        request_signature(
            &ctx.accounts.committee,
            &ctx.accounts.sig_request,
            &ctx.accounts.pool,
            &ctx.accounts.solver_authority.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            &ctx.accounts.soda_program,
            ctx.accounts.config.pool_bump,
            payload,
        )?;

        // Escrow moves after the CPI so soda's lamport accounting never sees
        // a pending edit on an account it was handed.
        let intent = &mut ctx.accounts.intent;
        move_lamports(
            &intent.to_account_info(),
            &ctx.accounts.solver_authority.to_account_info(),
            intent.in_lamports,
        )?;

        let sig_request = ctx.accounts.sig_request.key();
        intent.status = STATUS_FILLED;
        intent.solver = ctx.accounts.solver_authority.key();
        intent.out_wei = out_wei;
        intent.base_nonce = nonce;
        intent.gas_price = gas_price;
        intent.filled_at = now;
        intent.sig_requests[0] = sig_request;
        intent.sig_request_count = 1;

        emit!(EthTxRequested {
            sig_request,
            chain_id: CHAIN_ID,
            unsigned_rlp,
        });
        emit!(IntentFilled {
            intent: intent.key(),
            user: intent.user,
            solver: intent.solver,
            in_lamports: intent.in_lamports,
            out_wei,
            base_nonce: nonce,
            gas_price,
            sig_request,
            filled_at: now,
        });
        Ok(())
    }

    /// Re-sign the same payout at the same nonce with a higher gas price. Only
    /// one transaction per nonce can land, so this needs no Base read. Once all
    /// four slots are taken, pass one of the intent's SigRequests as a remaining
    /// account to reuse its slot: anyone may if it expired unsigned (it can never
    /// land), and the admin may for any slot.
    pub fn bump_gas(ctx: Context<BumpGas>, new_gas_price: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let intent = &ctx.accounts.intent;
        let caller = ctx.accounts.caller.key();
        let is_admin = caller == ctx.accounts.config.admin;

        require!(intent.status == STATUS_FILLED, IntentsError::IntentNotOpen);
        require!(
            caller == intent.solver
                || is_admin
                || now > intent.filled_at.saturating_add(ANYONE_CAN_BUMP_AFTER),
            IntentsError::NotFillingSolver
        );
        let slot = pick_slot(
            &intent.sig_requests,
            intent.sig_request_count,
            ctx.remaining_accounts,
            &ctx.accounts.pool.key(),
            is_admin,
            now,
        )?;
        let old_gas_price = intent.gas_price;
        // Bumps are charged to the filling solver whoever calls.
        let extra = bump_extra(&ctx.accounts.config, old_gas_price, new_gas_price)?;
        let solver = &mut ctx.accounts.solver;
        require!(solver.balance_wei >= extra, IntentsError::InsufficientSolverBalance);
        solver.balance_wei -= extra;

        let (unsigned_rlp, payload) =
            build_payout(intent.base_nonce, new_gas_price, &intent.recipient, intent.out_wei);
        request_signature(
            &ctx.accounts.committee,
            &ctx.accounts.sig_request,
            &ctx.accounts.pool,
            &ctx.accounts.caller.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            &ctx.accounts.soda_program,
            ctx.accounts.config.pool_bump,
            payload,
        )?;

        let sig_request = ctx.accounts.sig_request.key();
        let intent = &mut ctx.accounts.intent;
        intent.sig_requests[slot] = sig_request;
        if slot == intent.sig_request_count as usize {
            intent.sig_request_count += 1;
        }
        intent.gas_price = new_gas_price;

        emit!(EthTxRequested {
            sig_request,
            chain_id: CHAIN_ID,
            unsigned_rlp,
        });
        emit!(GasBumped {
            intent: intent.key(),
            caller,
            solver: intent.solver,
            base_nonce: intent.base_nonce,
            old_gas_price,
            new_gas_price,
            sig_request,
            sig_request_count: intent.sig_request_count,
        });
        Ok(())
    }

    /// Pay part of a solver's inventory out of the pool to its `payout_addr`.
    /// The withdrawal's own gas also comes out of the ledger.
    pub fn solver_withdraw(
        ctx: Context<SolverWithdraw>,
        expected_nonce: u64,
        amount_wei: u128,
        gas_price: u64,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, IntentsError::Paused);
        require!(amount_wei > 0, IntentsError::ZeroAmount);
        check_gas_price(config, gas_price)?;
        require!(expected_nonce == config.next_nonce, IntentsError::NonceMoved);

        let cost = payout_cost(amount_wei, gas_price, config.l1_fee_buffer_wei)?;
        let solver = &mut ctx.accounts.solver;
        require!(solver.balance_wei >= cost, IntentsError::InsufficientSolverBalance);
        solver.balance_wei -= cost;

        let nonce = config.next_nonce;
        ctx.accounts.config.next_nonce = nonce.checked_add(1).ok_or(IntentsError::MathOverflow)?;

        let payout_addr = ctx.accounts.solver.payout_addr;
        let (unsigned_rlp, payload) = build_payout(nonce, gas_price, &payout_addr, amount_wei);
        request_signature(
            &ctx.accounts.committee,
            &ctx.accounts.sig_request,
            &ctx.accounts.pool,
            &ctx.accounts.solver_authority.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            &ctx.accounts.soda_program,
            ctx.accounts.config.pool_bump,
            payload,
        )?;

        let sig_request = ctx.accounts.sig_request.key();
        let w = &mut ctx.accounts.withdrawal;
        w.solver = ctx.accounts.solver_authority.key();
        w.payout_addr = payout_addr;
        w.amount_wei = amount_wei;
        w.base_nonce = nonce;
        w.gas_price = gas_price;
        w.created_at = Clock::get()?.unix_timestamp;
        w.sig_requests[0] = sig_request;
        w.sig_request_count = 1;
        w.bump = ctx.bumps.withdrawal;

        emit!(EthTxRequested {
            sig_request,
            chain_id: CHAIN_ID,
            unsigned_rlp,
        });
        emit!(SolverWithdrew {
            solver: ctx.accounts.solver.authority,
            payout_addr,
            amount_wei,
            base_nonce: nonce,
            gas_price,
            sig_request,
            balance_wei: ctx.accounts.solver.balance_wei,
        });
        Ok(())
    }

    /// bump_gas for a withdrawal payout: same rules, keyed by its `Withdrawal`.
    pub fn bump_withdrawal_gas(ctx: Context<BumpWithdrawalGas>, new_gas_price: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let w = &ctx.accounts.withdrawal;
        let caller = ctx.accounts.caller.key();
        let is_admin = caller == ctx.accounts.config.admin;

        require!(
            caller == w.solver
                || is_admin
                || now > w.created_at.saturating_add(ANYONE_CAN_BUMP_AFTER),
            IntentsError::NotFillingSolver
        );
        let slot = pick_slot(
            &w.sig_requests,
            w.sig_request_count,
            ctx.remaining_accounts,
            &ctx.accounts.pool.key(),
            is_admin,
            now,
        )?;
        let old_gas_price = w.gas_price;
        let extra = bump_extra(&ctx.accounts.config, old_gas_price, new_gas_price)?;
        let solver = &mut ctx.accounts.solver;
        require!(solver.balance_wei >= extra, IntentsError::InsufficientSolverBalance);
        solver.balance_wei -= extra;

        let (unsigned_rlp, payload) =
            build_payout(w.base_nonce, new_gas_price, &w.payout_addr, w.amount_wei);
        request_signature(
            &ctx.accounts.committee,
            &ctx.accounts.sig_request,
            &ctx.accounts.pool,
            &ctx.accounts.caller.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            &ctx.accounts.soda_program,
            ctx.accounts.config.pool_bump,
            payload,
        )?;

        let sig_request = ctx.accounts.sig_request.key();
        let w = &mut ctx.accounts.withdrawal;
        w.sig_requests[slot] = sig_request;
        if slot == w.sig_request_count as usize {
            w.sig_request_count += 1;
        }
        w.gas_price = new_gas_price;

        emit!(EthTxRequested {
            sig_request,
            chain_id: CHAIN_ID,
            unsigned_rlp,
        });
        emit!(WithdrawalGasBumped {
            withdrawal: w.key(),
            caller,
            solver: w.solver,
            base_nonce: w.base_nonce,
            old_gas_price,
            new_gas_price,
            sig_request,
            sig_request_count: w.sig_request_count,
        });
        Ok(())
    }

    /// Funds the caller's RFQ vault. The first deposit creates it.
    pub fn deposit_sol(ctx: Context<DepositSol>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, IntentsError::Paused);
        require!(amount > 0, IntentsError::ZeroAmount);
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: ctx.accounts.user_vault.to_account_info(),
                },
            ),
            amount,
        )?;
        let vault = &mut ctx.accounts.user_vault;
        vault.owner = ctx.accounts.owner.key();
        vault.bump = ctx.bumps.user_vault;
        vault.sol = vault.sol.checked_add(amount).ok_or(IntentsError::MathOverflow)?;
        emit!(VaultDeposited {
            owner: vault.owner,
            amount,
            sol: vault.sol,
        });
        Ok(())
    }

    /// Ignores pause: users can always take their SOL back.
    pub fn withdraw_sol(ctx: Context<WithdrawSol>, amount: u64) -> Result<()> {
        require!(amount > 0, IntentsError::ZeroAmount);
        let vault = &mut ctx.accounts.user_vault;
        require!(vault.sol >= amount, IntentsError::InsufficientVaultBalance);
        move_lamports(
            &vault.to_account_info(),
            &ctx.accounts.owner.to_account_info(),
            amount,
        )?;
        vault.sol -= amount;
        emit!(VaultWithdrew {
            owner: vault.owner,
            amount,
            sol: vault.sol,
        });
        Ok(())
    }

    /// RFQ settlement. The solver signs the transaction (NEAR's
    /// set_auth_by_predecessor_id); the user's authorization is an Ed25519
    /// program instruction over `rfq::render_message(args)`. Pays `out_wei` on
    /// Base exactly like `fill`, then takes `sell_lamports` from the vault.
    pub fn execute_signed_intent(
        ctx: Context<ExecuteSignedIntent>,
        args: SignedIntentArgs,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let config = &ctx.accounts.config;
        require!(!config.paused, IntentsError::Paused);

        let ed25519_ix = load_instruction_at_checked(
            args.ed25519_ix_index as usize,
            &ctx.accounts.instructions.to_account_info(),
        )
        .map_err(|_| error!(IntentsError::InvalidSignatureInstruction))?;
        let message = rfq::render_message(
            &crate::ID,
            &args.user,
            args.nonce,
            args.deadline,
            args.sell_lamports,
            args.min_out_wei,
            &args.recipient,
        );
        rfq::check_ed25519_ix(&ed25519_ix, &args.user, &message)?;

        rfq::check_deadline(now, args.deadline)?;
        require!(
            args.sell_lamports > 0 && args.min_out_wei > 0,
            IntentsError::ZeroAmount
        );
        require!(args.out_wei >= args.min_out_wei, IntentsError::BelowRequiredOut);
        require!(args.recipient != [0u8; 20], IntentsError::ZeroRecipient);
        require!(
            ctx.accounts.user_vault.sol >= args.sell_lamports,
            IntentsError::InsufficientVaultBalance
        );
        check_gas_price(config, args.gas_price)?;
        require!(args.expected_nonce == config.next_nonce, IntentsError::NonceMoved);

        let cost = payout_cost(args.out_wei, args.gas_price, config.l1_fee_buffer_wei)?;
        let solver = &mut ctx.accounts.solver;
        require!(solver.balance_wei >= cost, IntentsError::InsufficientSolverBalance);
        solver.balance_wei -= cost;
        solver.fills = solver.fills.saturating_add(1);

        let nonce = config.next_nonce;
        ctx.accounts.config.next_nonce = nonce.checked_add(1).ok_or(IntentsError::MathOverflow)?;

        let (unsigned_rlp, payload) =
            build_payout(nonce, args.gas_price, &args.recipient, args.out_wei);
        request_signature(
            &ctx.accounts.committee,
            &ctx.accounts.sig_request,
            &ctx.accounts.pool,
            &ctx.accounts.solver_authority.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            &ctx.accounts.soda_program,
            ctx.accounts.config.pool_bump,
            payload,
        )?;

        // After the CPI, as in `fill`. The vault keeps its rent: sol sits above it.
        let vault = &mut ctx.accounts.user_vault;
        move_lamports(
            &vault.to_account_info(),
            &ctx.accounts.solver_authority.to_account_info(),
            args.sell_lamports,
        )?;
        vault.sol -= args.sell_lamports;

        // The same Filled record `fill` leaves, so bump_gas, the bots'
        // delivery loop and the page work unchanged. auction_duration 0 marks RFQ.
        let sig_request = ctx.accounts.sig_request.key();
        let intent = &mut ctx.accounts.intent;
        intent.user = args.user;
        intent.intent_id = args.nonce;
        intent.in_lamports = args.sell_lamports;
        intent.recipient = args.recipient;
        intent.start_out_wei = args.out_wei;
        intent.min_out_wei = args.min_out_wei;
        intent.auction_start = now;
        intent.auction_duration = 0;
        intent.expires_at = args.deadline;
        intent.status = STATUS_FILLED;
        intent.solver = ctx.accounts.solver_authority.key();
        intent.out_wei = args.out_wei;
        intent.base_nonce = nonce;
        intent.gas_price = args.gas_price;
        intent.filled_at = now;
        intent.sig_requests[0] = sig_request;
        intent.sig_request_count = 1;
        intent.bump = ctx.bumps.intent;

        emit!(EthTxRequested {
            sig_request,
            chain_id: CHAIN_ID,
            unsigned_rlp,
        });
        emit!(IntentFilled {
            intent: intent.key(),
            user: intent.user,
            solver: intent.solver,
            in_lamports: intent.in_lamports,
            out_wei: args.out_wei,
            base_nonce: nonce,
            gas_price: args.gas_price,
            sig_request,
            filled_at: now,
        });
        emit!(SignedIntentExecuted {
            intent: intent.key(),
            user: intent.user,
            solver: intent.solver,
            nonce: args.nonce,
            sell_lamports: args.sell_lamports,
            min_out_wei: args.min_out_wei,
            out_wei: args.out_wei,
            base_nonce: nonce,
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        Ok(())
    }

    /// Raising the cap is the escape hatch when a payout is stuck at it.
    pub fn set_max_gas_price(ctx: Context<AdminOnly>, max_gas_price: u64) -> Result<()> {
        require!(
            max_gas_price >= ctx.accounts.config.min_gas_price,
            IntentsError::BadGasConfig
        );
        ctx.accounts.config.max_gas_price = max_gas_price;
        Ok(())
    }

    /// Floor for every signed payout; keep it at or above Base's basefee.
    pub fn set_min_gas_price(ctx: Context<AdminOnly>, min_gas_price: u64) -> Result<()> {
        require!(
            min_gas_price > 0 && min_gas_price <= ctx.accounts.config.max_gas_price,
            IntentsError::BadGasConfig
        );
        ctx.accounts.config.min_gas_price = min_gas_price;
        Ok(())
    }
}

// ---------------------------------------------------------------- helpers

/// Linear Dutch auction (Fusion style): `start_out_wei` until `auction_start`,
/// falling to `min_out_wei` at `auction_start + auction_duration`. Floor
/// division, so the requirement rounds in the solver's favour by < 1 wei.
pub fn required_out(
    start_out_wei: u128,
    min_out_wei: u128,
    auction_start: i64,
    auction_duration: u32,
    now: i64,
) -> Option<u128> {
    if now <= auction_start {
        return Some(start_out_wei);
    }
    let elapsed = (now as i128 - auction_start as i128) as u128;
    let duration = auction_duration as u128;
    if elapsed >= duration {
        return Some(min_out_wei);
    }
    let spread = start_out_wei.checked_sub(min_out_wei)?;
    let decay = spread.checked_mul(elapsed)?.checked_div(duration)?;
    start_out_wei.checked_sub(decay)
}

/// What a payout takes out of the pool: value, gas at the signed price, and a
/// buffer for Base's L1 data fee.
fn payout_cost(value_wei: u128, gas_price: u64, l1_fee_buffer_wei: u64) -> Result<u128> {
    (gas_price as u128)
        .checked_mul(GAS_LIMIT as u128)
        .and_then(|gas| gas.checked_add(value_wei))
        .and_then(|c| c.checked_add(l1_fee_buffer_wei as u128))
        .ok_or_else(|| error!(IntentsError::MathOverflow))
}

fn check_gas_price(config: &Config, gas_price: u64) -> Result<()> {
    require!(gas_price >= config.min_gas_price, IntentsError::GasPriceTooLow);
    require!(gas_price <= config.max_gas_price, IntentsError::GasPriceTooHigh);
    Ok(())
}

/// Checks a bump's new price and returns the extra gas the ledger pays.
fn bump_extra(config: &Config, old_gas_price: u64, new_gas_price: u64) -> Result<u128> {
    let min_new = (old_gas_price as u128) * 110 / 100;
    require!(new_gas_price as u128 >= min_new, IntentsError::BumpTooSmall);
    check_gas_price(config, new_gas_price)?;
    Ok((new_gas_price.saturating_sub(old_gas_price) as u128) * (GAS_LIMIT as u128))
}

/// The sig_requests slot a bump writes: the next free one, else the slot of a
/// passed SigRequest that is dead (or any passed one, for the admin).
fn pick_slot(
    sig_requests: &[Pubkey; MAX_SIG_REQUESTS],
    count: u8,
    offered: &[AccountInfo],
    pool: &Pubkey,
    is_admin: bool,
    now: i64,
) -> Result<usize> {
    let count = count as usize;
    if count < MAX_SIG_REQUESTS {
        return Ok(count);
    }
    for acc in offered {
        let Some(i) = sig_requests.iter().position(|k| k == acc.key) else {
            continue;
        };
        let dead = acc.owner == &SODA_PROGRAM_ID
            && acc
                .try_borrow_data()
                .map(|d| sig_request_dead(&d, pool, now))
                .unwrap_or(false);
        if is_admin || dead {
            return Ok(i);
        }
    }
    err!(IntentsError::TooManyBumps)
}

/// True for a pool SigRequest that was never signed and expired more than
/// DEAD_SIG_REQUEST_AFTER ago. Layout (HANDOVER §1.4): disc 8, bump 1,
/// requester 32, committee 32, foreign_pk_xy 64, derivation_seeds (u32 len +
/// bytes), payload 32, chain_tag 32, domain_id u32, expires_at i64, completed u8.
fn sig_request_dead(data: &[u8], pool: &Pubkey, now: i64) -> bool {
    const SEEDS_LEN_AT: usize = 8 + 1 + 32 + 32 + 64;
    let Some(seeds_len) = data.get(SEEDS_LEN_AT..SEEDS_LEN_AT + 4) else {
        return false;
    };
    if data[..8] != SIG_REQUEST_DISC[..] || data[9..41] != pool.to_bytes()[..] {
        return false;
    }
    let seeds_len = u32::from_le_bytes(seeds_len.try_into().unwrap()) as usize;
    let at = SEEDS_LEN_AT + 4 + seeds_len + 32 + 32 + 4;
    let Some(tail) = data.get(at..at + 9) else {
        return false;
    };
    let expires_at = i64::from_le_bytes(tail[..8].try_into().unwrap());
    tail[8] == 0 && now > expires_at.saturating_add(DEAD_SIG_REQUEST_AFTER)
}

/// soda_witness `Claim`, read without the crate: Borsh fields in declaration
/// order after the 8-byte discriminator.
#[derive(AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct WitnessClaim {
    pub requester: Pubkey,
    pub chain_id: u64,
    pub tx_hash: [u8; 32],
    /// 0 Pending, 1 Recorded.
    pub status: u8,
    pub from: [u8; 20],
    pub to: [u8; 20],
    pub value_wei: u128,
    pub block: u64,
    pub success: bool,
    pub recorded_at: i64,
    pub bump: u8,
}

impl WitnessClaim {
    pub fn parse(data: &[u8]) -> Result<Self> {
        require!(
            data.len() >= CLAIM_LEN && data[..8] == CLAIM_DISC,
            IntentsError::InvalidClaim
        );
        Self::deserialize(&mut &data[8..CLAIM_LEN]).map_err(|_| error!(IntentsError::InvalidClaim))
    }
}

/// The facts a claim must show before it credits `solver`: a successful Base
/// Sepolia transfer of value from its `deposit_from` to the pool, claimed by
/// the solver's own key.
fn check_claim(claim: &WitnessClaim, pool_evm_addr: &[u8; 20], solver: &Solver) -> Result<()> {
    require!(claim.status == CLAIM_STATUS_RECORDED, IntentsError::ClaimNotRecorded);
    require!(claim.success, IntentsError::DepositReverted);
    require!(claim.chain_id == CHAIN_ID, IntentsError::ClaimWrongChain);
    require!(claim.to == *pool_evm_addr, IntentsError::DepositNotToPool);
    require!(claim.from == solver.deposit_from, IntentsError::DepositNotFromSolver);
    require_keys_eq!(claim.requester, solver.authority, IntentsError::ClaimNotBySolver);
    require!(claim.value_wei > 0, IntentsError::ZeroAmount);
    Ok(())
}

/// True when soda_witness `Config` data shows reports can come only from a
/// DON: the production forwarder, with `workflow_owner` pinned (that forwarder
/// lets any workflow write to any receiver).
fn witness_trusted(data: &[u8]) -> bool {
    if data.len() < WITNESS_CONFIG_LEN {
        return false;
    }
    data[40..72] == PRODUCTION_FORWARDER_ID.to_bytes()[..] && data[104..124] != [0u8; 20]
}

/// "intents register" || intents program id || solver authority.
pub fn deposit_proof_message(authority: &Pubkey) -> [u8; DEPOSIT_PROOF_LEN] {
    let mut m = [0u8; DEPOSIT_PROOF_LEN];
    m[..16].copy_from_slice(DEPOSIT_PROOF_TAG);
    m[16..48].copy_from_slice(crate::ID.as_ref());
    m[48..].copy_from_slice(authority.as_ref());
    m
}

/// The EVM address behind an EIP-191 personal_sign (r || s || v, v 27/28 or 0/1).
fn recover_evm_signer(msg: &[u8; DEPOSIT_PROOF_LEN], sig: &[u8; 65]) -> Option<[u8; 20]> {
    let digest = keccak::hashv(&[b"\x19Ethereum Signed Message:\n80", msg]).to_bytes();
    let v = match sig[64] {
        27 | 28 => sig[64] - 27,
        0 | 1 => sig[64],
        _ => return None,
    };
    let pk = secp256k1_recover(&digest, v, &sig[..64]).ok()?;
    let h = keccak::hash(&pk.to_bytes()).to_bytes();
    h[12..].try_into().ok()
}

/// Unsigned EIP-155 legacy transfer from the pool and the digest soda signs.
fn build_payout(nonce: u64, gas_price: u64, to: &[u8; 20], value_wei: u128) -> (Vec<u8>, [u8; 32]) {
    let unsigned_rlp = eth_rlp::encode_unsigned_legacy(
        nonce,
        gas_price,
        GAS_LIMIT,
        to,
        &value_wei.to_be_bytes(),
        &[],
        CHAIN_ID,
    );
    let payload = keccak::hashv(&[&unsigned_rlp]).to_bytes();
    (unsigned_rlp, payload)
}

/// Hand-built CPI to soda `request_signature` with the pool PDA as requester
/// (pattern from frontier vault_demo, without the soda crate).
#[allow(clippy::too_many_arguments)]
fn request_signature<'info>(
    committee: &AccountInfo<'info>,
    sig_request: &AccountInfo<'info>,
    pool: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    soda_program: &AccountInfo<'info>,
    pool_bump: u8,
    payload: [u8; 32],
) -> Result<()> {
    let mut data = REQUEST_SIGNATURE_DISC.to_vec();
    Vec::<u8>::new().serialize(&mut data)?; // derivation_seeds: empty
    data.extend_from_slice(&payload);
    data.extend_from_slice(&EVM_CHAIN_TAG);
    data.extend_from_slice(&0u32.to_le_bytes()); // domain_id: secp256k1 ECDSA

    let ix = Instruction {
        program_id: SODA_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(committee.key(), false),
            AccountMeta::new(sig_request.key(), false),
            AccountMeta::new_readonly(pool.key(), true),
            AccountMeta::new(payer.key(), true),
            AccountMeta::new_readonly(system_program.key(), false),
        ],
        data,
    };
    let bump = [pool_bump];
    let pool_seeds: &[&[u8]] = &[b"pool", &bump];
    invoke_signed(
        &ix,
        &[
            committee.clone(),
            sig_request.clone(),
            pool.clone(),
            payer.clone(),
            system_program.clone(),
            soda_program.clone(),
        ],
        &[pool_seeds],
    )?;
    Ok(())
}

/// Direct lamport edit out of a program-owned account. Callers only move the
/// escrow, which sits above rent, so the source stays rent-exempt.
fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    let mut from_lamports = from.try_borrow_mut_lamports()?;
    let mut to_lamports = to.try_borrow_mut_lamports()?;
    **from_lamports = from_lamports
        .checked_sub(amount)
        .ok_or(IntentsError::MathOverflow)?;
    **to_lamports = to_lamports
        .checked_add(amount)
        .ok_or(IntentsError::MathOverflow)?;
    Ok(())
}

// ---------------------------------------------------------------- accounts

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub pool_bump: u8,
    /// Display only; derived off-chain at init and checked in tests.
    pub pool_evm_addr: [u8; 20],
    pub next_nonce: u64,
    pub max_gas_price: u64,
    pub l1_fee_buffer_wei: u64,
    pub paused: bool,
    pub witness_program: Pubkey,
    /// Floor for fill, solver_withdraw and bump prices.
    pub min_gas_price: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Solver {
    pub authority: Pubkey,
    pub payout_addr: [u8; 20],
    pub deposit_from: [u8; 20],
    pub balance_wei: u128,
    pub fills: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Intent {
    pub user: Pubkey,
    pub intent_id: u64,
    /// Held as lamports in this account above rent while Open.
    pub in_lamports: u64,
    pub recipient: [u8; 20],
    pub start_out_wei: u128,
    pub min_out_wei: u128,
    pub auction_start: i64,
    pub auction_duration: u32,
    pub expires_at: i64,
    /// STATUS_OPEN, STATUS_FILLED or STATUS_CANCELLED.
    pub status: u8,
    /// The filling solver's authority (wallet), not its `Solver` PDA.
    pub solver: Pubkey,
    pub out_wei: u128,
    pub base_nonce: u64,
    pub gas_price: u64,
    pub filled_at: i64,
    /// The original payout plus up to 3 gas bumps; any one of them may land.
    pub sig_requests: [Pubkey; 4],
    pub sig_request_count: u8,
    pub bump: u8,
}

/// A solver_withdraw payout, kept so it can be bumped like a fill.
#[account]
#[derive(InitSpace)]
pub struct Withdrawal {
    /// The withdrawing solver's authority, whose ledger pays bumps.
    pub solver: Pubkey,
    pub payout_addr: [u8; 20],
    pub amount_wei: u128,
    pub base_nonce: u64,
    pub gas_price: u64,
    pub created_at: i64,
    pub sig_requests: [Pubkey; 4],
    pub sig_request_count: u8,
    pub bump: u8,
}

/// A user's SOL for RFQ trades. Seeds ["vault", owner]. Holds
/// rent-exempt minimum + `sol` lamports (more only if someone sends SOL
/// straight to it).
#[account]
#[derive(InitSpace)]
pub struct UserVault {
    pub owner: Pubkey,
    pub sol: u64,
    pub bump: u8,
}

/// Marks a Base deposit as credited, by either credit path. Seeds ["credit", tx_hash].
#[account]
#[derive(InitSpace)]
pub struct Credit {
    /// The credited solver's authority.
    pub solver: Pubkey,
    /// The soda_witness claim that proved the deposit; default for an admin credit.
    pub claim: Pubkey,
    pub tx_hash: [u8; 32],
    pub amount_wei: u128,
    pub credited_at: i64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    /// CHECK: data-less PDA, used only as the soda requester.
    #[account(seeds = [b"pool"], bump)]
    pub pool: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterSolver<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Solver::INIT_SPACE,
        seeds = [b"solver", authority.key().as_ref()],
        bump,
    )]
    pub solver: Account<'info, Solver>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(amount_wei: u128, tx_hash: [u8; 32])]
pub struct CreditSolver<'info> {
    /// Pays the Credit rent.
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump, has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"solver", solver.authority.as_ref()], bump = solver.bump)]
    pub solver: Account<'info, Solver>,
    /// Shared with credit_solver_from_claim: a deposit credits once either way.
    #[account(
        init,
        payer = admin,
        space = 8 + Credit::INIT_SPACE,
        seeds = [b"credit", tx_hash.as_ref()],
        bump,
    )]
    pub credit: Account<'info, Credit>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(tx_hash: [u8; 32])]
pub struct CreditSolverFromClaim<'info> {
    /// Anyone; pays the Credit rent.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// config.admin; must sign unless the witness is trusted (see the handler).
    pub admin: Option<Signer<'info>>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"solver", solver.authority.as_ref()], bump = solver.bump)]
    pub solver: Account<'info, Solver>,
    /// CHECK: soda_witness Claim; owner, discriminator and fields checked in the handler.
    pub claim: UncheckedAccount<'info>,
    /// CHECK: soda_witness Config PDA; its forwarder is read in the handler.
    #[account(
        seeds = [b"config"],
        bump,
        seeds::program = config.witness_program,
        owner = config.witness_program,
    )]
    pub witness_config: UncheckedAccount<'info>,
    /// Exists once per deposit; a second credit fails here (account in use).
    #[account(
        init,
        payer = payer,
        space = 8 + Credit::INIT_SPACE,
        seeds = [b"credit", tx_hash.as_ref()],
        bump,
    )]
    pub credit: Account<'info, Credit>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(intent_id: u64)]
pub struct OpenIntent<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = user,
        space = 8 + Intent::INIT_SPACE,
        seeds = [b"intent", user.key().as_ref(), &intent_id.to_le_bytes()],
        bump,
    )]
    pub intent: Box<Account<'info, Intent>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelIntent<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [b"intent", user.key().as_ref(), &intent.intent_id.to_le_bytes()],
        bump = intent.bump,
        has_one = user,
    )]
    pub intent: Box<Account<'info, Intent>>,
}

#[derive(Accounts)]
pub struct CloseIntent<'info> {
    /// The intent's user (Cancelled) or the admin (Filled).
    pub closer: Signer<'info>,
    /// CHECK: receives the rent; pinned by has_one and the seeds.
    #[account(mut)]
    pub user: UncheckedAccount<'info>,
    #[account(seeds = [b"config"], bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [b"intent", user.key().as_ref(), &intent.intent_id.to_le_bytes()],
        bump = intent.bump,
        has_one = user,
        close = user,
    )]
    pub intent: Box<Account<'info, Intent>>,
}

#[derive(Accounts)]
pub struct Fill<'info> {
    /// Receives the escrowed SOL and pays the SigRequest rent.
    #[account(mut)]
    pub solver_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"solver", solver_authority.key().as_ref()],
        bump = solver.bump,
    )]
    pub solver: Box<Account<'info, Solver>>,
    #[account(mut, seeds = [b"config"], bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [b"intent", intent.user.as_ref(), &intent.intent_id.to_le_bytes()],
        bump = intent.bump,
    )]
    pub intent: Box<Account<'info, Intent>>,
    /// CHECK: address-pinned; soda checks it further.
    #[account(address = SODA_COMMITTEE)]
    pub committee: UncheckedAccount<'info>,
    /// CHECK: created by soda at ["sig", pool, payload]; soda checks the seeds.
    #[account(mut)]
    pub sig_request: UncheckedAccount<'info>,
    /// CHECK: data-less PDA, signs the soda CPI via invoke_signed.
    #[account(seeds = [b"pool"], bump = config.pool_bump)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: address-pinned soda program.
    #[account(address = SODA_PROGRAM_ID)]
    pub soda_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BumpGas<'info> {
    /// The filling solver, the admin, or anyone once `filled_at + 60` has passed. Pays
    /// the new SigRequest rent.
    #[account(mut)]
    pub caller: Signer<'info>,
    /// The filling solver's ledger, debited for the extra gas.
    #[account(
        mut,
        seeds = [b"solver", intent.solver.as_ref()],
        bump = solver.bump,
    )]
    pub solver: Box<Account<'info, Solver>>,
    #[account(seeds = [b"config"], bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [b"intent", intent.user.as_ref(), &intent.intent_id.to_le_bytes()],
        bump = intent.bump,
    )]
    pub intent: Box<Account<'info, Intent>>,
    /// CHECK: address-pinned; soda checks it further.
    #[account(address = SODA_COMMITTEE)]
    pub committee: UncheckedAccount<'info>,
    /// CHECK: created by soda at ["sig", pool, payload]; soda checks the seeds.
    #[account(mut)]
    pub sig_request: UncheckedAccount<'info>,
    /// CHECK: data-less PDA, signs the soda CPI via invoke_signed.
    #[account(seeds = [b"pool"], bump = config.pool_bump)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: address-pinned soda program.
    #[account(address = SODA_PROGRAM_ID)]
    pub soda_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(expected_nonce: u64)]
pub struct SolverWithdraw<'info> {
    #[account(mut)]
    pub solver_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"solver", solver_authority.key().as_ref()],
        bump = solver.bump,
    )]
    pub solver: Box<Account<'info, Solver>>,
    #[account(mut, seeds = [b"config"], bump)]
    pub config: Box<Account<'info, Config>>,
    /// Keyed by the nonce the handler checks equals next_nonce.
    #[account(
        init,
        payer = solver_authority,
        space = 8 + Withdrawal::INIT_SPACE,
        seeds = [b"withdrawal".as_ref(), &expected_nonce.to_le_bytes()],
        bump,
    )]
    pub withdrawal: Box<Account<'info, Withdrawal>>,
    /// CHECK: address-pinned; soda checks it further.
    #[account(address = SODA_COMMITTEE)]
    pub committee: UncheckedAccount<'info>,
    /// CHECK: created by soda at ["sig", pool, payload]; soda checks the seeds.
    #[account(mut)]
    pub sig_request: UncheckedAccount<'info>,
    /// CHECK: data-less PDA, signs the soda CPI via invoke_signed.
    #[account(seeds = [b"pool"], bump = config.pool_bump)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: address-pinned soda program.
    #[account(address = SODA_PROGRAM_ID)]
    pub soda_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BumpWithdrawalGas<'info> {
    /// The withdrawing solver, the admin, or anyone once `created_at + 60` has
    /// passed. Pays the new SigRequest rent.
    #[account(mut)]
    pub caller: Signer<'info>,
    /// The withdrawing solver's ledger, debited for the extra gas.
    #[account(
        mut,
        seeds = [b"solver", withdrawal.solver.as_ref()],
        bump = solver.bump,
    )]
    pub solver: Box<Account<'info, Solver>>,
    #[account(seeds = [b"config"], bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [b"withdrawal".as_ref(), &withdrawal.base_nonce.to_le_bytes()],
        bump = withdrawal.bump,
    )]
    pub withdrawal: Box<Account<'info, Withdrawal>>,
    /// CHECK: address-pinned; soda checks it further.
    #[account(address = SODA_COMMITTEE)]
    pub committee: UncheckedAccount<'info>,
    /// CHECK: created by soda at ["sig", pool, payload]; soda checks the seeds.
    #[account(mut)]
    pub sig_request: UncheckedAccount<'info>,
    /// CHECK: data-less PDA, signs the soda CPI via invoke_signed.
    #[account(seeds = [b"pool"], bump = config.pool_bump)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: address-pinned soda program.
    #[account(address = SODA_PROGRAM_ID)]
    pub soda_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositSol<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"config"], bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + UserVault::INIT_SPACE,
        seeds = [b"vault", owner.key().as_ref()],
        bump,
    )]
    pub user_vault: Account<'info, UserVault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawSol<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = user_vault.bump,
        has_one = owner,
    )]
    pub user_vault: Account<'info, UserVault>,
}

#[derive(Accounts)]
#[instruction(args: SignedIntentArgs)]
pub struct ExecuteSignedIntent<'info> {
    /// The winning solver: pays the Intent and SigRequest rent, receives the SOL.
    #[account(mut)]
    pub solver_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"solver", solver_authority.key().as_ref()],
        bump = solver.bump,
    )]
    pub solver: Box<Account<'info, Solver>>,
    #[account(mut, seeds = [b"config"], bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"vault", args.user.as_ref()], bump = user_vault.bump)]
    pub user_vault: Box<Account<'info, UserVault>>,
    /// Exists once per (user, nonce): a replayed signature fails here.
    #[account(
        init,
        payer = solver_authority,
        space = 8 + Intent::INIT_SPACE,
        seeds = [b"intent", args.user.as_ref(), &args.nonce.to_le_bytes()],
        bump,
    )]
    pub intent: Box<Account<'info, Intent>>,
    /// CHECK: address-pinned; soda checks it further.
    #[account(address = SODA_COMMITTEE)]
    pub committee: UncheckedAccount<'info>,
    /// CHECK: created by soda at ["sig", pool, payload]; soda checks the seeds.
    #[account(mut)]
    pub sig_request: UncheckedAccount<'info>,
    /// CHECK: data-less PDA, signs the soda CPI via invoke_signed.
    #[account(seeds = [b"pool"], bump = config.pool_bump)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: address-pinned soda program.
    #[account(address = SODA_PROGRAM_ID)]
    pub soda_program: UncheckedAccount<'info>,
    /// CHECK: address-pinned instructions sysvar; holds the Ed25519 instruction.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

// ---------------------------------------------------------------- events

/// Exact name and field order of frontier eth_demo's event: the relayer
/// matches on its discriminator and broadcasts the signed payout.
#[event]
pub struct EthTxRequested {
    pub sig_request: Pubkey,
    pub chain_id: u64,
    pub unsigned_rlp: Vec<u8>,
}

#[event]
pub struct IntentOpened {
    pub intent: Pubkey,
    pub user: Pubkey,
    pub intent_id: u64,
    pub in_lamports: u64,
    pub recipient: [u8; 20],
    pub start_out_wei: u128,
    pub min_out_wei: u128,
    pub auction_start: i64,
    pub auction_duration: u32,
    pub expires_at: i64,
}

#[event]
pub struct IntentFilled {
    pub intent: Pubkey,
    pub user: Pubkey,
    /// Solver authority (wallet).
    pub solver: Pubkey,
    pub in_lamports: u64,
    pub out_wei: u128,
    pub base_nonce: u64,
    pub gas_price: u64,
    pub sig_request: Pubkey,
    pub filled_at: i64,
}

#[event]
pub struct IntentCancelled {
    pub intent: Pubkey,
    pub user: Pubkey,
    pub refunded_lamports: u64,
}

#[event]
pub struct GasBumped {
    pub intent: Pubkey,
    pub caller: Pubkey,
    /// Filling solver authority, whose ledger paid the extra gas.
    pub solver: Pubkey,
    pub base_nonce: u64,
    pub old_gas_price: u64,
    pub new_gas_price: u64,
    pub sig_request: Pubkey,
    pub sig_request_count: u8,
}

#[event]
pub struct WithdrawalGasBumped {
    pub withdrawal: Pubkey,
    pub caller: Pubkey,
    /// Withdrawing solver authority, whose ledger paid the extra gas.
    pub solver: Pubkey,
    pub base_nonce: u64,
    pub old_gas_price: u64,
    pub new_gas_price: u64,
    pub sig_request: Pubkey,
    pub sig_request_count: u8,
}

#[event]
pub struct SolverCredited {
    pub solver: Pubkey,
    pub amount_wei: u128,
    pub balance_wei: u128,
}

#[event]
pub struct SolverCreditedFromClaim {
    /// Solver authority (wallet).
    pub solver: Pubkey,
    pub claim: Pubkey,
    pub tx_hash: [u8; 32],
    pub amount_wei: u128,
    pub balance_wei: u128,
}

#[event]
pub struct SolverWithdrew {
    pub solver: Pubkey,
    pub payout_addr: [u8; 20],
    pub amount_wei: u128,
    pub base_nonce: u64,
    pub gas_price: u64,
    pub sig_request: Pubkey,
    pub balance_wei: u128,
}

#[event]
pub struct VaultDeposited {
    pub owner: Pubkey,
    pub amount: u64,
    /// Vault balance after the deposit.
    pub sol: u64,
}

#[event]
pub struct VaultWithdrew {
    pub owner: Pubkey,
    pub amount: u64,
    pub sol: u64,
}

/// Emitted after EthTxRequested and IntentFilled by execute_signed_intent.
#[event]
pub struct SignedIntentExecuted {
    pub intent: Pubkey,
    pub user: Pubkey,
    /// Solver authority (wallet).
    pub solver: Pubkey,
    /// The user's signed nonce, also the Intent's intent_id.
    pub nonce: u64,
    pub sell_lamports: u64,
    pub min_out_wei: u128,
    pub out_wei: u128,
    pub base_nonce: u64,
}

// ---------------------------------------------------------------- errors

#[error_code]
pub enum IntentsError {
    #[msg("Program is paused")]
    Paused,
    #[msg("Intent is not in the required status")]
    IntentNotOpen,
    #[msg("Intent has expired")]
    IntentExpired,
    #[msg("out_wei is below the auction's required output")]
    BelowRequiredOut,
    #[msg("Gas price is above max_gas_price")]
    GasPriceTooHigh,
    #[msg("Solver balance does not cover the payout")]
    InsufficientSolverBalance,
    #[msg("Pool nonce moved; re-read config.next_nonce")]
    NonceMoved,
    #[msg("Only the filling solver may bump before filled_at + 60")]
    NotFillingSolver,
    #[msg("New gas price must be at least 110% of the old one")]
    BumpTooSmall,
    #[msg("No sig_request slots left")]
    TooManyBumps,
    #[msg("Bad auction parameters")]
    BadAuctionParams,
    #[msg("Intent cannot be closed yet")]
    NotClosable,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Gas price is below min_gas_price")]
    GasPriceTooLow,
    #[msg("Amount must be above zero")]
    ZeroAmount,
    #[msg("Need 0 < min_gas_price <= max_gas_price")]
    BadGasConfig,
    // Phase 2 (credit_solver_from_claim). Append only: codes are part of the ABI.
    #[msg("Claim is not owned by config.witness_program")]
    ClaimNotFromWitness,
    #[msg("Account is not a soda_witness Claim")]
    InvalidClaim,
    #[msg("Claim tx_hash does not match the instruction's tx_hash")]
    ClaimTxHashMismatch,
    #[msg("Claim is not Recorded")]
    ClaimNotRecorded,
    #[msg("Recorded deposit reverted on Base")]
    DepositReverted,
    #[msg("Claim is not for Base Sepolia (84532)")]
    ClaimWrongChain,
    #[msg("Deposit did not go to pool_evm_addr")]
    DepositNotToPool,
    #[msg("Deposit was not sent from the solver's deposit_from")]
    DepositNotFromSolver,
    #[msg("Claim requester is not the solver's authority")]
    ClaimNotBySolver,
    #[msg("Witness accepts unauthenticated reports; the admin must co-sign")]
    UntrustedWitness,
    #[msg("deposit_sig is not deposit_from's signature over the register message")]
    DepositFromNotProven,
    // RFQ-lite (execute_signed_intent, user vaults).
    #[msg("Not a single-signature Ed25519 instruction verifying its own data")]
    InvalidSignatureInstruction,
    #[msg("Ed25519 signer or message does not match the intent")]
    SignatureMismatch,
    #[msg("Signed intent deadline has passed")]
    DeadlinePassed,
    #[msg("Signed intent deadline is more than 600 s away")]
    DeadlineTooFar,
    #[msg("Vault SOL balance is too low")]
    InsufficientVaultBalance,
    #[msg("Recipient is the zero address")]
    ZeroRecipient,
}

#[cfg(test)]
mod tests {
    use super::*;

    const START: u128 = 1_000_000_000_000_000_000; // 1 ETH
    const MIN: u128 = 900_000_000_000_000_000;
    const T0: i64 = 1_700_000_000;
    const DUR: u32 = 120;

    #[test]
    fn required_out_before_and_at_start() {
        assert_eq!(required_out(START, MIN, T0, DUR, T0 - 10), Some(START));
        assert_eq!(required_out(START, MIN, T0, DUR, T0), Some(START));
    }

    #[test]
    fn required_out_middle() {
        assert_eq!(required_out(START, MIN, T0, DUR, T0 + 60), Some(950_000_000_000_000_000));
        // Floor division: 100e15 * 1 / 120 = 833333333333333.33.. → requirement rounds up.
        assert_eq!(
            required_out(START, MIN, T0, DUR, T0 + 1),
            Some(START - 833_333_333_333_333)
        );
    }

    #[test]
    fn required_out_end_and_after() {
        assert_eq!(required_out(START, MIN, T0, DUR, T0 + DUR as i64), Some(MIN));
        assert_eq!(required_out(START, MIN, T0, DUR, T0 + 10_000), Some(MIN));
    }

    #[test]
    fn required_out_zero_duration_and_flat() {
        assert_eq!(required_out(START, MIN, T0, 0, T0), Some(START));
        assert_eq!(required_out(START, MIN, T0, 0, T0 + 1), Some(MIN));
        assert_eq!(required_out(MIN, MIN, T0, DUR, T0 + 30), Some(MIN));
    }

    #[test]
    fn required_out_overflow_is_none() {
        assert_eq!(required_out(u128::MAX, 0, T0, u32::MAX, T0 + 1_000_000), None);
    }

    #[test]
    fn payout_cost_adds_gas_and_buffer() {
        assert_eq!(
            payout_cost(1_000, 2, 5).unwrap(),
            1_000 + 2 * GAS_LIMIT as u128 + 5
        );
        assert!(payout_cost(u128::MAX, 1, 0).is_err());
    }

    #[test]
    fn evm_chain_tag_is_evm_zero_padded() {
        assert_eq!(&EVM_CHAIN_TAG[..3], b"evm");
        assert!(EVM_CHAIN_TAG[3..].iter().all(|b| *b == 0));
    }

    fn sig_request_bytes(pool: &Pubkey, seeds: &[u8], expires_at: i64, completed: bool) -> Vec<u8> {
        let mut d = SIG_REQUEST_DISC.to_vec();
        d.push(255);
        d.extend_from_slice(pool.as_ref());
        d.extend_from_slice(&[0u8; 32 + 64]);
        d.extend_from_slice(&(seeds.len() as u32).to_le_bytes());
        d.extend_from_slice(seeds);
        d.extend_from_slice(&[0u8; 32 + 32 + 4]);
        d.extend_from_slice(&expires_at.to_le_bytes());
        d.push(completed as u8);
        d.extend_from_slice(&[0u8; 65]);
        d.resize(347, 0);
        d
    }

    #[test]
    fn sig_request_dead_needs_unsigned_and_expired_past_margin() {
        let pool = Pubkey::new_unique();
        let exp = T0 + 300;
        let edge = exp + DEAD_SIG_REQUEST_AFTER;
        assert!(!sig_request_dead(&sig_request_bytes(&pool, &[], exp, false), &pool, edge));
        assert!(sig_request_dead(&sig_request_bytes(&pool, &[], exp, false), &pool, edge + 1));
        assert!(!sig_request_dead(&sig_request_bytes(&pool, &[], exp, true), &pool, edge + 1));
        // Seeds shift the tail; the parser follows the length prefix.
        assert!(sig_request_dead(&sig_request_bytes(&pool, &[7; 40], exp, false), &pool, edge + 1));
        assert!(!sig_request_dead(&sig_request_bytes(&pool, &[7; 40], exp, true), &pool, edge + 1));
    }

    #[test]
    fn sig_request_dead_rejects_foreign_or_malformed_data() {
        let pool = Pubkey::new_unique();
        let late = T0 + 10_000;
        let other = sig_request_bytes(&Pubkey::new_unique(), &[], T0, false);
        assert!(!sig_request_dead(&other, &pool, late), "another requester");
        let mut bad_disc = sig_request_bytes(&pool, &[], T0, false);
        bad_disc[0] ^= 1;
        assert!(!sig_request_dead(&bad_disc, &pool, late));
        assert!(!sig_request_dead(&[0u8; 100], &pool, late));
        let mut huge_seeds = sig_request_bytes(&pool, &[], T0, false);
        huge_seeds[137..141].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(!sig_request_dead(&huge_seeds, &pool, late));
    }

    #[test]
    fn bump_extra_enforces_ten_percent_floor_and_cap() {
        let mut c = Config {
            admin: Pubkey::default(),
            pool_bump: 254,
            pool_evm_addr: [0; 20],
            next_nonce: 0,
            max_gas_price: 5_000,
            l1_fee_buffer_wei: 0,
            paused: false,
            witness_program: Pubkey::default(),
            min_gas_price: 100,
        };
        assert_eq!(bump_extra(&c, 1_000, 1_100).unwrap(), 100 * GAS_LIMIT as u128);
        assert!(bump_extra(&c, 1_000, 1_099).is_err());
        assert!(bump_extra(&c, 1_000, 5_001).is_err());
        // A raised floor lifts even a zero-priced payout.
        assert!(bump_extra(&c, 0, 99).is_err());
        c.min_gas_price = 50;
        assert!(bump_extra(&c, 0, 99).is_ok());
    }

    #[test]
    fn account_sizes() {
        assert_eq!(8 + Config::INIT_SPACE, 126);
        assert_eq!(8 + Withdrawal::INIT_SPACE, 230);
        assert_eq!(8 + Solver::INIT_SPACE, 105);
        assert_eq!(8 + Intent::INIT_SPACE, 331);
        assert_eq!(8 + Credit::INIT_SPACE, 129);
        assert_eq!(8 + UserVault::INIT_SPACE, 49);
    }

    const POOL_EVM: [u8; 20] = [0x76; 20];
    const FROM: [u8; 20] = [0x31; 20];

    fn solver() -> Solver {
        Solver {
            authority: Pubkey::new_from_array([5; 32]),
            payout_addr: [0x99; 20],
            deposit_from: FROM,
            balance_wei: 0,
            fills: 0,
            bump: 255,
        }
    }

    fn claim() -> WitnessClaim {
        WitnessClaim {
            requester: Pubkey::new_from_array([5; 32]),
            chain_id: CHAIN_ID,
            tx_hash: [0xb9; 32],
            status: CLAIM_STATUS_RECORDED,
            from: FROM,
            to: POOL_EVM,
            value_wei: START,
            block: 47_799_710,
            success: true,
            recorded_at: T0,
            bump: 254,
        }
    }

    /// Bytes as soda_witness stores them, built field by field.
    fn claim_bytes(c: &WitnessClaim) -> Vec<u8> {
        let mut d = CLAIM_DISC.to_vec();
        d.extend_from_slice(c.requester.as_ref());
        d.extend_from_slice(&c.chain_id.to_le_bytes());
        d.extend_from_slice(&c.tx_hash);
        d.push(c.status);
        d.extend_from_slice(&c.from);
        d.extend_from_slice(&c.to);
        d.extend_from_slice(&c.value_wei.to_le_bytes());
        d.extend_from_slice(&c.block.to_le_bytes());
        d.push(c.success as u8);
        d.extend_from_slice(&c.recorded_at.to_le_bytes());
        d.push(c.bump);
        d
    }

    #[test]
    fn claim_discriminator_and_layout() {
        use solana_program::hash::hash;
        assert_eq!(&hash(b"account:Claim").to_bytes()[..8], &CLAIM_DISC);
        let bytes = claim_bytes(&claim());
        assert_eq!(bytes.len(), CLAIM_LEN);
        assert_eq!(WitnessClaim::parse(&bytes).unwrap(), claim());
    }

    #[test]
    fn claim_parse_rejects_foreign_or_short_data() {
        let bytes = claim_bytes(&claim());
        let mut bad_disc = bytes.clone();
        bad_disc[0] ^= 1;
        let invalid = error!(IntentsError::InvalidClaim);
        assert_eq!(WitnessClaim::parse(&bad_disc).unwrap_err(), invalid);
        assert_eq!(WitnessClaim::parse(&bytes[..CLAIM_LEN - 1]).unwrap_err(), invalid);
        let mut bad_bool = bytes;
        bad_bool[8 + 32 + 8 + 32 + 1 + 20 + 20 + 16 + 8] = 2; // success
        assert_eq!(WitnessClaim::parse(&bad_bool).unwrap_err(), invalid);
    }

    #[test]
    fn check_claim_judges_every_fact() {
        let s = solver();
        assert!(check_claim(&claim(), &POOL_EVM, &s).is_ok());
        let cases: [(fn(&mut WitnessClaim), IntentsError); 7] = [
            (|c| c.status = 0, IntentsError::ClaimNotRecorded),
            (|c| c.success = false, IntentsError::DepositReverted),
            (|c| c.chain_id = 8453, IntentsError::ClaimWrongChain),
            (|c| c.to = [1; 20], IntentsError::DepositNotToPool),
            (|c| c.from = [2; 20], IntentsError::DepositNotFromSolver),
            (|c| c.requester = Pubkey::new_from_array([6; 32]), IntentsError::ClaimNotBySolver),
            (|c| c.value_wei = 0, IntentsError::ZeroAmount),
        ];
        for (edit, want) in cases {
            let mut c = claim();
            edit(&mut c);
            assert_eq!(check_claim(&c, &POOL_EVM, &s).unwrap_err(), error!(want));
        }
    }

    fn witness_config(forwarder: Pubkey, owner: [u8; 20]) -> Vec<u8> {
        let mut d = vec![0u8; WITNESS_CONFIG_LEN];
        d[40..72].copy_from_slice(forwarder.as_ref());
        d[104..124].copy_from_slice(&owner);
        d
    }

    #[test]
    fn witness_trusted_needs_production_forwarder_and_owner_pin() {
        let mock = pubkey!("7kuEAA3mSC1Tz8gQjnvH7bKFda9xSPRRin9SZbH49cNK");
        assert!(witness_trusted(&witness_config(PRODUCTION_FORWARDER_ID, [1; 20])));
        assert!(!witness_trusted(&witness_config(PRODUCTION_FORWARDER_ID, [0; 20])));
        assert!(!witness_trusted(&witness_config(mock, [1; 20])));
        let short = witness_config(PRODUCTION_FORWARDER_ID, [1; 20]);
        assert!(!witness_trusted(&short[..WITNESS_CONFIG_LEN - 1]));
    }

    /// personal_sign by key 0x46..46 (address 0x9d8a..5a4f, the EIP-155
    /// example key) over deposit_proof_message([5; 32]), made with noble.
    const PROOF_SIG: &str = "23ac4512da552760084a04b3239900d577b764d229ff79dd37eda723a125b0ff6668ba3ae0d323e747e6377b26f3b04b5b62483f10183a50930668f0a67a7d401c";
    const PROOF_ADDR: &str = "9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f";

    fn unhex<const N: usize>(s: &str) -> [u8; N] {
        let v: Vec<u8> = (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect();
        v.try_into().unwrap()
    }

    #[test]
    fn deposit_proof_recovers_the_signer() {
        let authority = Pubkey::new_from_array([5; 32]);
        let msg = deposit_proof_message(&authority);
        assert_eq!(&msg[..16], b"intents register");
        assert_eq!(&msg[16..48], crate::ID.as_ref());
        let mut sig: [u8; 65] = unhex(PROOF_SIG);
        let addr: [u8; 20] = unhex(PROOF_ADDR);
        assert_eq!(recover_evm_signer(&msg, &sig), Some(addr));
        sig[64] -= 27; // raw recovery id
        assert_eq!(recover_evm_signer(&msg, &sig), Some(addr));
        sig[64] = 29;
        assert_eq!(recover_evm_signer(&msg, &sig), None);
        // Bound to the authority: another solver cannot replay it.
        let other = deposit_proof_message(&Pubkey::new_from_array([6; 32]));
        assert_ne!(recover_evm_signer(&other, &unhex(PROOF_SIG)), Some(addr));
    }
}
