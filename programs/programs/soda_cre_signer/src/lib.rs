//! soda_cre_signer: lets a Chainlink CRE workflow finalize soda signatures.
//!
//! The CRE workflow reaches consensus on an MPC signature for a soda
//! `SigRequest` and writes a `SignerReport` through the keystone forwarder
//! into `on_report`. This program checks the forwarder, then CPIs soda's
//! `finalize_signature` with its own `["submitter"]` PDA as the submitter.
//! soda verifies the signature itself (secp256k1_recover against the stored
//! foreign key), so a bad report can only fail, never forge.
//!
//! Forwarder checks are copied from soda_witness.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

declare_id!("2cgtuK2Y9BQ8uMbVpYwM9FZ7TVkSqu9xegNTyBp3taxM");

/// Only this key may create or change the config.
pub const ADMIN: Pubkey = pubkey!("57Y6siThZ6JUjjpgQ7JT7JUFVk4e1xcAsCDRHJBQUXkE");
pub const SODA_PROGRAM_ID: Pubkey = pubkey!("CPAEfBXpMMsUrjLNhDYxaCH79DYvFHJFC27fttnxAL1J");
pub const SODA_COMMITTEE: Pubkey = pubkey!("9mX3oHUmsrYvzXjCo35HhfXufrGZT3hjsLoC74xbA6SS");

/// `SignerReport.ver` this program accepts.
pub const REPORT_VERSION: u8 = 1;
/// Borsh size of `SignerReport`.
pub const REPORT_LEN: usize = 98;
pub const METADATA_LEN: usize = 64;

/// sha256("global:finalize_signature")[..8]
pub const FINALIZE_SIGNATURE_DISC: [u8; 8] = [0xb0, 0xf3, 0xb1, 0x39, 0x7b, 0x0b, 0x93, 0xbd];
/// soda `SigRequest` account discriminator.
pub const SIG_REQUEST_DISC: [u8; 8] = [0x36, 0x17, 0xd2, 0x80, 0x7b, 0xe9, 0xf1, 0xe9];

pub const SUBMITTER_SEED: &[u8] = b"submitter";

#[program]
pub mod soda_cre_signer {
    use super::*;

    pub fn init_config(
        ctx: Context<InitConfig>,
        forwarder_program: Pubkey,
        forwarder_state: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.forwarder_program = forwarder_program;
        config.forwarder_state = forwarder_state;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Switches between the mock and production forwarders.
    pub fn set_config(
        ctx: Context<SetConfig>,
        forwarder_program: Pubkey,
        forwarder_state: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.forwarder_program = forwarder_program;
        config.forwarder_state = forwarder_state;
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
            SignerError::MismatchedForwarderProgram
        );
        require_keys_eq!(state.key(), config.forwarder_state, SignerError::InvalidForwarderState);
        let (expected_authority, _) = Pubkey::find_program_address(
            &[b"forwarder", state.key().as_ref(), crate::ID.as_ref()],
            &config.forwarder_program,
        );
        require_keys_eq!(
            ctx.accounts.forwarder_authority.key(),
            expected_authority,
            SignerError::InvalidForwarderAuthority
        );
        require!(metadata.len() == METADATA_LEN, SignerError::InvalidMetadataLength);

        let report = SignerReport::decode(&report)?;
        let sig_request = &ctx.accounts.sig_request;
        require_keys_eq!(sig_request.key(), report.sig_request, SignerError::SigRequestMismatch);

        let completed = {
            let data = sig_request.try_borrow_data()?;
            sig_request_completed(&data)?
        };
        if completed {
            emit!(AlreadyFinalized { sig_request: report.sig_request });
            return Ok(());
        }

        let mut data = Vec::with_capacity(8 + 64 + 1);
        data.extend_from_slice(&FINALIZE_SIGNATURE_DISC);
        data.extend_from_slice(&report.signature);
        data.push(report.recovery_id);
        let ix = Instruction {
            program_id: SODA_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(ctx.accounts.committee.key(), false),
                AccountMeta::new(sig_request.key(), false),
                AccountMeta::new_readonly(ctx.accounts.submitter.key(), true),
            ],
            data,
        };
        invoke_signed(
            &ix,
            &[
                ctx.accounts.committee.to_account_info(),
                sig_request.to_account_info(),
                ctx.accounts.submitter.to_account_info(),
                ctx.accounts.soda_program.to_account_info(),
            ],
            &[&[SUBMITTER_SEED, &[ctx.bumps.submitter]]],
        )?;

        emit!(CreFinalized { report });
        Ok(())
    }
}

/// Borsh payload the CRE workflow writes (98 bytes).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct SignerReport {
    pub ver: u8,
    pub sig_request: Pubkey,
    /// r || s
    pub signature: [u8; 64],
    pub recovery_id: u8,
}

impl SignerReport {
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        require!(bytes.len() == REPORT_LEN, SignerError::InvalidReportLength);
        let report =
            Self::try_from_slice(bytes).map_err(|_| error!(SignerError::InvalidReportLength))?;
        require!(report.ver == REPORT_VERSION, SignerError::UnsupportedReportVersion);
        Ok(report)
    }
}

/// Reads `completed` from raw soda `SigRequest` data:
/// disc[8] | bump u8 | requester 32 | committee 32 | foreign_pk_xy 64
/// | derivation_seeds Vec<u8> | payload 32 | chain_tag 32 | domain_id u32
/// | expires_at i64 | completed bool | ...
pub fn sig_request_completed(data: &[u8]) -> Result<bool> {
    require!(
        data.len() >= 8 && data[..8] == SIG_REQUEST_DISC,
        SignerError::InvalidSigRequest
    );
    let seeds_len_at = 8 + 1 + 32 + 32 + 64;
    let len_bytes: [u8; 4] = data
        .get(seeds_len_at..seeds_len_at + 4)
        .ok_or(error!(SignerError::InvalidSigRequest))?
        .try_into()
        .unwrap();
    let seeds_len = u32::from_le_bytes(len_bytes) as usize;
    let completed_at = seeds_len_at + 4 + seeds_len + 32 + 32 + 4 + 8;
    match data.get(completed_at) {
        Some(0) => Ok(false),
        Some(1) => Ok(true),
        _ => err!(SignerError::InvalidSigRequest),
    }
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub forwarder_program: Pubkey,
    pub forwarder_state: Pubkey,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut, address = ADMIN @ SignerError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetConfig<'info> {
    #[account(address = ADMIN @ SignerError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ SignerError::NotAdmin)]
    pub config: Account<'info, Config>,
}

/// Order is fixed by the forwarder: state, forwarder_authority, then the
/// workflow's remaining accounts.
#[derive(Accounts)]
pub struct OnReport<'info> {
    /// CHECK: forwarder state; owner and key checked against config in on_report.
    pub state: UncheckedAccount<'info>,
    /// PDA ["forwarder", state, this program] under the forwarder; checked in on_report.
    pub forwarder_authority: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: soda SigRequest; owner checked here, layout parsed in on_report, soda re-checks.
    #[account(mut, owner = SODA_PROGRAM_ID @ SignerError::InvalidSigRequest)]
    pub sig_request: UncheckedAccount<'info>,
    /// CHECK: soda committee PDA; pinned by address.
    #[account(address = SODA_COMMITTEE @ SignerError::InvalidCommittee)]
    pub committee: UncheckedAccount<'info>,
    /// CHECK: this program's ["submitter"] PDA; signs the soda CPI.
    #[account(seeds = [SUBMITTER_SEED], bump)]
    pub submitter: UncheckedAccount<'info>,
    /// CHECK: soda program; pinned by address.
    #[account(address = SODA_PROGRAM_ID @ SignerError::InvalidSodaProgram)]
    pub soda_program: UncheckedAccount<'info>,
}

/// Also puts `SignerReport` in the IDL, which `cre generate-bindings` needs.
#[event]
pub struct CreFinalized {
    pub report: SignerReport,
}

#[event]
pub struct AlreadyFinalized {
    pub sig_request: Pubkey,
}

#[error_code]
pub enum SignerError {
    #[msg("Signer is not the admin")]
    NotAdmin,
    #[msg("Forwarder state is not owned by config.forwarder_program")]
    MismatchedForwarderProgram,
    #[msg("Forwarder state is not config.forwarder_state")]
    InvalidForwarderState,
    #[msg("forwarder_authority is not the PDA for this state, receiver and forwarder program")]
    InvalidForwarderAuthority,
    #[msg("Metadata must be 64 bytes")]
    InvalidMetadataLength,
    #[msg("Report must be a 98-byte Borsh SignerReport")]
    InvalidReportLength,
    #[msg("Unsupported SignerReport version")]
    UnsupportedReportVersion,
    #[msg("sig_request account does not match the report")]
    SigRequestMismatch,
    #[msg("sig_request is not a valid soda SigRequest")]
    InvalidSigRequest,
    #[msg("committee is not the soda committee")]
    InvalidCommittee,
    #[msg("soda_program is not soda")]
    InvalidSodaProgram,
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::Discriminator;
    use solana_program::hash::hash;

    fn sample() -> SignerReport {
        SignerReport {
            ver: REPORT_VERSION,
            sig_request: Pubkey::new_from_array([9; 32]),
            signature: [5; 64],
            recovery_id: 1,
        }
    }

    #[test]
    fn discriminators() {
        assert_eq!(&hash(b"global:finalize_signature").to_bytes()[..8], &FINALIZE_SIGNATURE_DISC);
        assert_eq!(&hash(b"account:SigRequest").to_bytes()[..8], &SIG_REQUEST_DISC);
        assert_eq!(instruction::OnReport::DISCRIMINATOR, &[214, 173, 18, 221, 173, 148, 151, 208]);
    }

    #[test]
    fn report_decode_length_and_version() {
        let bytes = sample().try_to_vec().unwrap();
        assert_eq!(bytes.len(), REPORT_LEN);
        assert_eq!(SignerReport::decode(&bytes).unwrap(), sample());
        assert_eq!(
            SignerReport::decode(&bytes[..97]).unwrap_err(),
            error!(SignerError::InvalidReportLength)
        );
        let mut v2 = bytes;
        v2[0] = 2;
        assert_eq!(
            SignerReport::decode(&v2).unwrap_err(),
            error!(SignerError::UnsupportedReportVersion)
        );
    }

    #[test]
    fn completed_flag_offset() {
        // Synthetic 347-byte SigRequest with 3 derivation seed bytes.
        let seeds = [7u8, 8, 9];
        let mut d = Vec::new();
        d.extend_from_slice(&SIG_REQUEST_DISC);
        d.push(254); // bump
        d.extend_from_slice(&[1; 32]); // requester
        d.extend_from_slice(&[2; 32]); // committee
        d.extend_from_slice(&[3; 64]); // foreign_pk_xy
        d.extend_from_slice(&(seeds.len() as u32).to_le_bytes());
        d.extend_from_slice(&seeds);
        d.extend_from_slice(&[4; 32]); // payload
        d.extend_from_slice(&[6; 32]); // chain_tag
        d.extend_from_slice(&0u32.to_le_bytes()); // domain_id
        d.extend_from_slice(&1_700_000_000i64.to_le_bytes()); // expires_at
        let completed_at = d.len();
        d.push(0);
        d.extend_from_slice(&[0; 64]);
        d.push(0);
        d.resize(347, 0);
        assert!(!sig_request_completed(&d).unwrap());
        d[completed_at] = 1;
        assert!(sig_request_completed(&d).unwrap());
        d[0] ^= 1;
        assert!(sig_request_completed(&d).is_err());
    }
}
