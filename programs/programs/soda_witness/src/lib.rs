//! soda_witness: brings facts about EVM transactions back to Solana.
//!
//! A caller opens a Pending `Claim` for a (chain_id, tx_hash). A Chainlink CRE
//! workflow reads that transaction, reaches consensus, and writes a
//! `WitnessReport` through the keystone forwarder into `on_report`, which
//! checks the forwarder and records from, to, value, block and success.
//! Consumers (e.g. intents' Phase 2) judge the recorded facts themselves.
//!
//! Forwarder checks follow cre-templates' `kv_store_receiver`.

use anchor_lang::prelude::*;

declare_id!("5v97wLYgMzyfQfpZWGQ6uPXTHh4JsJitUXPReYy2uuTp");

pub const STATUS_PENDING: u8 = 0;
pub const STATUS_RECORDED: u8 = 1;

/// `WitnessReport.ver` this program accepts.
pub const REPORT_VERSION: u8 = 1;
/// Borsh size of `WitnessReport`.
pub const REPORT_LEN: usize = 106;

/// Receiver metadata: workflow_cid[0..32] | workflow_name[32..42] | workflow_owner[42..62] | report_id[62..64].
pub const METADATA_LEN: usize = 64;
const WORKFLOW_NAME: core::ops::Range<usize> = 32..42;
const WORKFLOW_OWNER: core::ops::Range<usize> = 42..62;

#[program]
pub mod soda_witness {
    use super::*;

    pub fn init_config(
        ctx: Context<InitConfig>,
        forwarder_program: Pubkey,
        forwarder_state: Pubkey,
        workflow_owner: [u8; 20],
        workflow_name: [u8; 10],
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.bump = ctx.bumps.config;
        config.apply(forwarder_program, forwarder_state, workflow_owner, workflow_name);
        Ok(())
    }

    /// Switches between the mock and production forwarders, or pins the workflow.
    pub fn set_config(
        ctx: Context<SetConfig>,
        forwarder_program: Pubkey,
        forwarder_state: Pubkey,
        workflow_owner: [u8; 20],
        workflow_name: [u8; 10],
    ) -> Result<()> {
        ctx.accounts
            .config
            .apply(forwarder_program, forwarder_state, workflow_owner, workflow_name);
        Ok(())
    }

    /// Creates the caller's Pending claim. It must exist before the report
    /// arrives, because no payer reaches `on_report`.
    pub fn open_claim(ctx: Context<OpenClaim>, chain_id: u64, tx_hash: [u8; 32]) -> Result<()> {
        let claim = &mut ctx.accounts.claim;
        claim.requester = ctx.accounts.requester.key();
        claim.chain_id = chain_id;
        claim.tx_hash = tx_hash;
        claim.status = STATUS_PENDING;
        claim.bump = ctx.bumps.claim;

        emit!(ClaimOpened {
            claim: claim.key(),
            requester: claim.requester,
            chain_id,
            tx_hash,
        });
        Ok(())
    }

    /// Called by the keystone forwarder via CPI; the name fixes the
    /// discriminator to [214,173,18,221,173,148,151,208].
    pub fn on_report(ctx: Context<OnReport>, metadata: Vec<u8>, report: Vec<u8>) -> Result<()> {
        let config = &ctx.accounts.config;
        let state = &ctx.accounts.state;

        require_keys_eq!(
            *state.owner,
            config.forwarder_program,
            WitnessError::MismatchedForwarderProgram
        );
        require_keys_eq!(state.key(), config.forwarder_state, WitnessError::InvalidForwarderState);

        let (expected_authority, _) = Pubkey::find_program_address(
            &[b"forwarder", state.key().as_ref(), crate::ID.as_ref()],
            &config.forwarder_program,
        );
        require_keys_eq!(
            ctx.accounts.forwarder_authority.key(),
            expected_authority,
            WitnessError::InvalidForwarderAuthority
        );

        check_metadata(&metadata, config)?;
        let report = WitnessReport::decode(&report)?;

        let claim = &mut ctx.accounts.claim;
        require!(claim.status == STATUS_PENDING, WitnessError::ClaimNotPending);
        require!(report.chain_id == claim.chain_id, WitnessError::ChainIdMismatch);
        require!(report.tx_hash == claim.tx_hash, WitnessError::TxHashMismatch);

        claim.from = report.from;
        claim.to = report.to;
        claim.value_wei = report.value_wei;
        claim.block = report.block;
        claim.success = report.status == 1;
        claim.recorded_at = Clock::get()?.unix_timestamp;
        claim.status = STATUS_RECORDED;

        emit!(ClaimRecorded {
            claim: claim.key(),
            requester: claim.requester,
            success: claim.success,
        });
        emit!(WitnessRecorded { report });
        Ok(())
    }
}

/// Borsh payload the CRE workflow writes (106 bytes).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct WitnessReport {
    pub ver: u8,
    pub chain_id: u64,
    pub tx_hash: [u8; 32],
    pub from: [u8; 20],
    pub to: [u8; 20],
    pub value_wei: u128,
    pub block: u64,
    /// EVM receipt status: 1 success, 0 reverted.
    pub status: u8,
}

impl WitnessReport {
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        require!(bytes.len() == REPORT_LEN, WitnessError::InvalidReportLength);
        let report =
            Self::try_from_slice(bytes).map_err(|_| error!(WitnessError::InvalidReportLength))?;
        require!(report.ver == REPORT_VERSION, WitnessError::UnsupportedReportVersion);
        Ok(report)
    }
}

fn check_metadata(metadata: &[u8], config: &Config) -> Result<()> {
    // Logged before any check so the first simulation run shows the
    // workflow owner and name to pin with set_config.
    msg!("metadata: {}", to_hex(metadata));
    require!(metadata.len() == METADATA_LEN, WitnessError::InvalidMetadataLength);
    if config.workflow_owner != [0u8; 20] {
        require!(
            metadata[WORKFLOW_OWNER] == config.workflow_owner,
            WitnessError::WorkflowOwnerMismatch
        );
    }
    if config.workflow_name != [0u8; 10] {
        require!(
            metadata[WORKFLOW_NAME] == config.workflow_name,
            WitnessError::WorkflowNameMismatch
        );
    }
    Ok(())
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub forwarder_program: Pubkey,
    pub forwarder_state: Pubkey,
    /// All zeros skips the check.
    pub workflow_owner: [u8; 20],
    /// All zeros skips the check.
    pub workflow_name: [u8; 10],
    pub bump: u8,
}

impl Config {
    fn apply(
        &mut self,
        forwarder_program: Pubkey,
        forwarder_state: Pubkey,
        workflow_owner: [u8; 20],
        workflow_name: [u8; 10],
    ) {
        self.forwarder_program = forwarder_program;
        self.forwarder_state = forwarder_state;
        self.workflow_owner = workflow_owner;
        self.workflow_name = workflow_name;
    }
}

#[account]
#[derive(InitSpace)]
pub struct Claim {
    pub requester: Pubkey,
    pub chain_id: u64,
    pub tx_hash: [u8; 32],
    /// STATUS_PENDING or STATUS_RECORDED.
    pub status: u8,
    pub from: [u8; 20],
    pub to: [u8; 20],
    pub value_wei: u128,
    pub block: u64,
    pub success: bool,
    pub recorded_at: i64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ WitnessError::NotAdmin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(chain_id: u64, tx_hash: [u8; 32])]
pub struct OpenClaim<'info> {
    #[account(mut)]
    pub requester: Signer<'info>,
    #[account(
        init,
        payer = requester,
        space = 8 + Claim::INIT_SPACE,
        seeds = [b"claim", requester.key().as_ref(), &chain_id.to_le_bytes(), &tx_hash],
        bump,
    )]
    pub claim: Account<'info, Claim>,
    pub system_program: Program<'info, System>,
}

/// Order is fixed by the forwarder: state, forwarder_authority, then the
/// workflow's remaining accounts (config, claim).
#[derive(Accounts)]
pub struct OnReport<'info> {
    /// CHECK: forwarder state; owner and key checked against config in on_report.
    pub state: UncheckedAccount<'info>,
    /// PDA ["forwarder", state, this program] under the forwarder; checked in on_report.
    pub forwarder_authority: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub claim: Account<'info, Claim>,
}

#[event]
pub struct ClaimOpened {
    pub claim: Pubkey,
    pub requester: Pubkey,
    pub chain_id: u64,
    pub tx_hash: [u8; 32],
}

#[event]
pub struct ClaimRecorded {
    pub claim: Pubkey,
    pub requester: Pubkey,
    pub success: bool,
}

/// Also puts `WitnessReport` in the IDL, which `cre generate-bindings` needs.
#[event]
pub struct WitnessRecorded {
    pub report: WitnessReport,
}

#[error_code]
pub enum WitnessError {
    #[msg("Signer is not the config admin")]
    NotAdmin,
    #[msg("Forwarder state is not owned by config.forwarder_program")]
    MismatchedForwarderProgram,
    #[msg("Forwarder state is not config.forwarder_state")]
    InvalidForwarderState,
    #[msg("forwarder_authority is not the PDA for this state, receiver and forwarder program")]
    InvalidForwarderAuthority,
    #[msg("Metadata must be 64 bytes")]
    InvalidMetadataLength,
    #[msg("Metadata workflow_owner does not match config")]
    WorkflowOwnerMismatch,
    #[msg("Metadata workflow_name does not match config")]
    WorkflowNameMismatch,
    #[msg("Report must be a 106-byte Borsh WitnessReport")]
    InvalidReportLength,
    #[msg("Unsupported WitnessReport version")]
    UnsupportedReportVersion,
    #[msg("Claim is not Pending")]
    ClaimNotPending,
    #[msg("Report chain_id does not match the claim")]
    ChainIdMismatch,
    #[msg("Report tx_hash does not match the claim")]
    TxHashMismatch,
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::Discriminator;
    use solana_program::hash::hash;

    fn sample() -> WitnessReport {
        WitnessReport {
            ver: REPORT_VERSION,
            chain_id: 84_532,
            tx_hash: [7; 32],
            from: [1; 20],
            to: [2; 20],
            value_wei: 1_000_000_000_000_000,
            block: 123,
            status: 1,
        }
    }

    #[test]
    fn on_report_discriminator_matches_forwarder() {
        let expected = [214, 173, 18, 221, 173, 148, 151, 208];
        assert_eq!(&hash(b"global:on_report").to_bytes()[..8], &expected);
        assert_eq!(instruction::OnReport::DISCRIMINATOR, &expected);
    }

    #[test]
    fn report_is_106_bytes_and_round_trips() {
        let bytes = sample().try_to_vec().unwrap();
        assert_eq!(bytes.len(), REPORT_LEN);
        assert_eq!(WitnessReport::decode(&bytes).unwrap(), sample());
    }

    #[test]
    fn report_rejects_bad_length_and_version() {
        let bytes = sample().try_to_vec().unwrap();
        assert_eq!(
            WitnessReport::decode(&bytes[..105]).unwrap_err(),
            error!(WitnessError::InvalidReportLength)
        );
        let mut long = bytes.clone();
        long.push(0);
        assert_eq!(
            WitnessReport::decode(&long).unwrap_err(),
            error!(WitnessError::InvalidReportLength)
        );
        let mut v2 = bytes;
        v2[0] = 2;
        assert_eq!(
            WitnessReport::decode(&v2).unwrap_err(),
            error!(WitnessError::UnsupportedReportVersion)
        );
    }

    #[test]
    fn account_sizes() {
        assert_eq!(Config::INIT_SPACE, 32 * 3 + 20 + 10 + 1);
        assert_eq!(Claim::INIT_SPACE, 32 + 8 + 32 + 1 + 20 + 20 + 16 + 8 + 1 + 8 + 1);
    }

    #[test]
    fn metadata_checks() {
        let mut config = Config {
            admin: Pubkey::default(),
            forwarder_program: Pubkey::default(),
            forwarder_state: Pubkey::default(),
            workflow_owner: [0; 20],
            workflow_name: [0; 10],
            bump: 0,
        };
        let mut meta = [0u8; METADATA_LEN];
        meta[32..42].copy_from_slice(b"sodawitnes");
        meta[42..62].copy_from_slice(&[0xaa; 20]);

        // Zeros skip both checks; length is always checked.
        assert!(check_metadata(&meta, &config).is_ok());
        for len in [0, 63, 65] {
            let m = vec![0u8; len];
            assert_eq!(
                check_metadata(&m, &config).unwrap_err(),
                error!(WitnessError::InvalidMetadataLength)
            );
        }

        config.workflow_owner = [0xbb; 20];
        assert_eq!(
            check_metadata(&meta, &config).unwrap_err(),
            error!(WitnessError::WorkflowOwnerMismatch)
        );
        config.workflow_owner = [0xaa; 20];
        assert!(check_metadata(&meta, &config).is_ok());

        config.workflow_name = *b"otherflow!";
        assert_eq!(
            check_metadata(&meta, &config).unwrap_err(),
            error!(WitnessError::WorkflowNameMismatch)
        );
        config.workflow_name = *b"sodawitnes";
        assert!(check_metadata(&meta, &config).is_ok());
    }

    #[test]
    fn hex() {
        assert_eq!(to_hex(&[0x00, 0xab, 0x0f]), "00ab0f");
    }
}
