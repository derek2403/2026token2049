//! RFQ-lite, NEAR Intents style: solvers quote off-chain, the user signs a
//! canonical text message in Phantom (no transaction), and the winning solver
//! submits `execute_signed_intent` carrying an Ed25519 program instruction that
//! verifies that signature. The program never parses the text: it renders the
//! message from the instruction args and compares bytes.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;

use crate::IntentsError;

/// Longest gap a signed intent may leave between submission and its deadline.
pub const MAX_DEADLINE_SECS: i64 = 600;

const ED25519_OFFSETS_START: usize = 2; // num_signatures u8 + padding u8
const ED25519_OFFSETS_LEN: usize = 14; // seven u16
const ED25519_PK_LEN: usize = 32;
const ED25519_SIG_LEN: usize = 64;
/// Instruction index meaning "this instruction's own data".
const THIS_INSTRUCTION: u16 = u16::MAX;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct SignedIntentArgs {
    /// The signer: the user's wallet and the vault owner.
    pub user: Pubkey,
    /// Picks the Intent PDA, so it is the user's replay protection.
    pub nonce: u64,
    pub deadline: i64,
    pub sell_lamports: u64,
    pub min_out_wei: u128,
    pub recipient: [u8; 20],
    /// What the solver pays, at least min_out_wei. Not signed by the user.
    pub out_wei: u128,
    /// config.next_nonce the solver read (the Base nonce).
    pub expected_nonce: u64,
    pub gas_price: u64,
    /// Position of the Ed25519 program instruction in this transaction.
    pub ed25519_ix_index: u8,
}

/// The exact bytes the user signs. Shared with lib/intents/rfq.ts through
/// lib/intents/rfq-vectors.json; any change here is a new message version.
pub fn render_message(
    program_id: &Pubkey,
    user: &Pubkey,
    nonce: u64,
    deadline: i64,
    sell_lamports: u64,
    min_out_wei: u128,
    recipient: &[u8; 20],
) -> Vec<u8> {
    let mut m = Vec::with_capacity(360);
    m.extend_from_slice(b"SODA Intents v1\nverifier: ");
    m.extend_from_slice(&base58_32(program_id.as_ref()));
    m.extend_from_slice(b" devnet\nsigner: ");
    m.extend_from_slice(&base58_32(user.as_ref()));
    m.extend_from_slice(b"\nnonce: ");
    push_u128(&mut m, nonce as u128);
    m.extend_from_slice(b"\ndeadline: ");
    if deadline < 0 {
        m.push(b'-');
    }
    push_u128(&mut m, deadline.unsigned_abs() as u128);
    m.extend_from_slice(b"\nsell: ");
    push_u128(&mut m, sell_lamports as u128);
    m.extend_from_slice(b" lamports SOL\nreceive at least: ");
    push_u128(&mut m, min_out_wei);
    m.extend_from_slice(b" wei ETH\nto: 0x");
    for b in recipient {
        m.push(HEX[(b >> 4) as usize]);
        m.push(HEX[(b & 15) as usize]);
    }
    m.extend_from_slice(b" on base-sepolia (84532)");
    m
}

const HEX: &[u8; 16] = b"0123456789abcdef";
const BASE58: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// Bitcoin-alphabet base58 of 32 bytes, as `Pubkey::to_string`. Hand-rolled:
/// it is about 8 KB smaller on SBF than going through Display (five8).
fn base58_32(bytes: &[u8]) -> Vec<u8> {
    let mut digits = [0u8; 44]; // little-endian base-58 digits
    let mut len = 0;
    for &b in bytes {
        let mut carry = b as u32;
        for d in digits[..len].iter_mut() {
            carry += (*d as u32) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits[len] = (carry % 58) as u8;
            len += 1;
            carry /= 58;
        }
    }
    let zeros = bytes.iter().take_while(|b| **b == 0).count();
    let mut out = vec![b'1'; zeros];
    out.extend(digits[..len].iter().rev().map(|d| BASE58[*d as usize]));
    out
}

/// Decimal, no leading zeros. Stays in u64 when it can (u128 division is a
/// software routine on SBF).
fn push_u128(out: &mut Vec<u8>, v: u128) {
    let mut buf = [0u8; 39];
    let mut i = buf.len();
    if let Ok(mut s) = u64::try_from(v) {
        loop {
            i -= 1;
            buf[i] = b'0' + (s % 10) as u8;
            s /= 10;
            if s == 0 {
                break;
            }
        }
    } else {
        let mut s = v;
        while s != 0 {
            i -= 1;
            buf[i] = b'0' + (s % 10) as u8;
            s /= 10;
        }
    }
    out.extend_from_slice(&buf[i..]);
}

/// `now <= deadline <= now + MAX_DEADLINE_SECS`.
pub fn check_deadline(now: i64, deadline: i64) -> Result<()> {
    require!(now <= deadline, IntentsError::DeadlinePassed);
    require!(
        deadline <= now.saturating_add(MAX_DEADLINE_SECS),
        IntentsError::DeadlineTooFar
    );
    Ok(())
}

/// A verified (public key, message) pair read out of an Ed25519 instruction.
#[derive(Debug, PartialEq, Eq)]
pub struct Ed25519Entry<'a> {
    pub public_key: &'a [u8; ED25519_PK_LEN],
    pub signature: &'a [u8; ED25519_SIG_LEN],
    pub message: &'a [u8],
}

/// Reads the single signature entry of Ed25519 program instruction data.
/// Every `*_instruction_index` must be u16::MAX, so the precompile verified
/// exactly these bytes in this instruction; a different index would let it
/// check a signature held in some other instruction while we read data here
/// that nobody signed. Everything is read through the offsets, bounds-checked.
pub fn parse_ed25519_single(data: &[u8]) -> Result<Ed25519Entry<'_>> {
    let bad = || error!(IntentsError::InvalidSignatureInstruction);
    let header = data
        .get(..ED25519_OFFSETS_START + ED25519_OFFSETS_LEN)
        .ok_or_else(bad)?;
    require!(header[0] == 1, IntentsError::InvalidSignatureInstruction);
    let o = &header[ED25519_OFFSETS_START..];
    let u16_at = |i: usize| u16::from_le_bytes([o[i], o[i + 1]]);
    let (sig_off, sig_ix) = (u16_at(0), u16_at(2));
    let (pk_off, pk_ix) = (u16_at(4), u16_at(6));
    let (msg_off, msg_len, msg_ix) = (u16_at(8), u16_at(10), u16_at(12));
    require!(
        sig_ix == THIS_INSTRUCTION && pk_ix == THIS_INSTRUCTION && msg_ix == THIS_INSTRUCTION,
        IntentsError::InvalidSignatureInstruction
    );
    let slice = |off: u16, len: usize| data.get(off as usize..off as usize + len).ok_or_else(bad);
    Ok(Ed25519Entry {
        signature: slice(sig_off, ED25519_SIG_LEN)?.try_into().unwrap(),
        public_key: slice(pk_off, ED25519_PK_LEN)?.try_into().unwrap(),
        message: slice(msg_off, msg_len as usize)?,
    })
}

/// The instruction must be the Ed25519 program verifying `signer` over
/// exactly `expected_msg`.
pub fn check_ed25519_ix(ix: &Instruction, signer: &Pubkey, expected_msg: &[u8]) -> Result<()> {
    require_keys_eq!(
        ix.program_id,
        solana_program::ed25519_program::ID,
        IntentsError::InvalidSignatureInstruction
    );
    let entry = parse_ed25519_single(&ix.data)?;
    require!(
        entry.public_key == &signer.to_bytes() && entry.message == expected_msg,
        IntentsError::SignatureMismatch
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Vector {
        name: &'static str,
        program_id: Pubkey,
        user: Pubkey,
        nonce: u64,
        deadline: i64,
        sell_lamports: u64,
        min_out_wei: u128,
        recipient: [u8; 20],
    }

    fn hex20(s: &str) -> [u8; 20] {
        let v: Vec<u8> = (0..40)
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect();
        v.try_into().unwrap()
    }

    fn vectors() -> Vec<Vector> {
        let mut leading_zero = [0u8; 20];
        leading_zero[19] = 1;
        vec![
            Vector {
                name: "typical",
                program_id: crate::ID,
                user: pubkey!("D5pwjGzqvgvuFt4rtMVf1ta4RKXWyGGfG2ekh5KuDfZw"),
                nonce: 1_759_830_000_123,
                deadline: 1_759_830_120,
                sell_lamports: 100_000_000,
                min_out_wei: 2_138_000_000_000_000,
                recipient: hex20("dd8e2f5a0b1c3d4e5f60718293a4b5c6d7e8f901"),
            },
            Vector {
                name: "zeros",
                program_id: crate::ID,
                user: Pubkey::new_from_array([0; 32]),
                nonce: 0,
                deadline: 0,
                sell_lamports: 1,
                min_out_wei: 1,
                recipient: leading_zero,
            },
            Vector {
                name: "maxima",
                program_id: crate::ID,
                user: Pubkey::new_from_array([255; 32]),
                nonce: u64::MAX,
                deadline: i64::MAX,
                sell_lamports: u64::MAX,
                min_out_wei: u128::MAX,
                recipient: [0xff; 20],
            },
            Vector {
                name: "negative_deadline_and_u128_wei",
                program_id: crate::ID,
                user: Pubkey::new_from_array([1; 32]),
                nonce: 10,
                deadline: i64::MIN,
                sell_lamports: 1_000_000_000,
                min_out_wei: 18_446_744_073_709_551_616, // u64::MAX + 1
                recipient: hex20("0000000000000000000000000000000000000abc"),
            },
            Vector {
                name: "other_verifier",
                program_id: Pubkey::new_from_array([7; 32]),
                user: pubkey!("CozgNEdiG93qqo8cxXeXddvuT3F1Gh6zHr4VLro1sZ54"),
                nonce: 5,
                deadline: 1_759_830_600,
                sell_lamports: 250_000_000,
                min_out_wei: 5_000_000_000_000_000,
                recipient: hex20("3177aa00bb11cc22dd33ee44ff5566778899aabb"),
            },
        ]
    }

    fn render(v: &Vector) -> Vec<u8> {
        render_message(
            &v.program_id,
            &v.user,
            v.nonce,
            v.deadline,
            v.sell_lamports,
            v.min_out_wei,
            &v.recipient,
        )
    }

    fn json_str(s: &str) -> String {
        let mut out = String::from("\"");
        for c in s.chars() {
            match c {
                '\n' => out.push_str("\\n"),
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                c => out.push(c),
            }
        }
        out.push('"');
        out
    }

    /// The shared vectors file, rendered by this crate. Integers are strings
    /// so JavaScript reads u64/u128/i64 without precision loss.
    fn vectors_json() -> String {
        let mut j = String::from("{\n  \"comment\": \"Generated by `UPDATE_RFQ_VECTORS=1 cargo test -p intents rfq`. Canonical SODA Intents v1 messages; lib/intents/rfq.ts must render identical bytes.\",\n  \"vectors\": [\n");
        let all = vectors();
        for (i, v) in all.iter().enumerate() {
            let msg = String::from_utf8(render(v)).unwrap();
            let hex: String = msg.bytes().map(|b| format!("{b:02x}")).collect();
            let rcpt: String = v.recipient.iter().map(|b| format!("{b:02x}")).collect();
            j.push_str(&format!(
                "    {{\n      \"name\": {},\n      \"program_id\": \"{}\",\n      \"user\": \"{}\",\n      \"nonce\": \"{}\",\n      \"deadline\": \"{}\",\n      \"sell_lamports\": \"{}\",\n      \"min_out_wei\": \"{}\",\n      \"recipient\": \"0x{}\",\n      \"message\": {},\n      \"message_hex\": \"{}\",\n      \"message_len\": {}\n    }}{}\n",
                json_str(v.name),
                v.program_id,
                v.user,
                v.nonce,
                v.deadline,
                v.sell_lamports,
                v.min_out_wei,
                rcpt,
                json_str(&msg),
                hex,
                msg.len(),
                if i + 1 < all.len() { "," } else { "" },
            ));
        }
        j.push_str("  ]\n}\n");
        j
    }

    const VECTORS_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../lib/intents/rfq-vectors.json"
    );

    #[test]
    fn rfq_vectors_file_matches_renderer() {
        let want = vectors_json();
        if std::env::var("UPDATE_RFQ_VECTORS").is_ok() {
            std::fs::write(VECTORS_PATH, &want).unwrap();
        }
        let have = std::fs::read_to_string(VECTORS_PATH).expect("lib/intents/rfq-vectors.json");
        assert_eq!(
            have, want,
            "run UPDATE_RFQ_VECTORS=1 cargo test -p intents rfq"
        );
    }

    #[test]
    fn rfq_message_exact_bytes() {
        let v = &vectors()[0];
        let want = "SODA Intents v1\n\
verifier: BV9KfzKwXPp9hQZEyhoVm9STbDy7gCGCmKcKpCDr8jXA devnet\n\
signer: D5pwjGzqvgvuFt4rtMVf1ta4RKXWyGGfG2ekh5KuDfZw\n\
nonce: 1759830000123\n\
deadline: 1759830120\n\
sell: 100000000 lamports SOL\n\
receive at least: 2138000000000000 wei ETH\n\
to: 0xdd8e2f5a0b1c3d4e5f60718293a4b5c6d7e8f901 on base-sepolia (84532)";
        assert_eq!(String::from_utf8(render(v)).unwrap(), want);
    }

    #[test]
    fn rfq_message_number_edges() {
        let all = vectors();
        let zeros = String::from_utf8(render(&all[1])).unwrap();
        assert!(zeros.contains("\nnonce: 0\ndeadline: 0\n"));
        assert!(zeros.contains("signer: 11111111111111111111111111111111\n"));
        assert!(zeros
            .ends_with("to: 0x0000000000000000000000000000000000000001 on base-sepolia (84532)"));
        let max = String::from_utf8(render(&all[2])).unwrap();
        assert!(max.contains("\nnonce: 18446744073709551615\n"));
        assert!(max.contains("\ndeadline: 9223372036854775807\n"));
        assert!(max.contains(&format!("receive at least: {} wei ETH", u128::MAX)));
        assert!(max.contains("to: 0xffffffffffffffffffffffffffffffffffffffff "));
        let neg = String::from_utf8(render(&all[3])).unwrap();
        assert!(neg.contains("\ndeadline: -9223372036854775808\n"));
        assert!(neg.contains("receive at least: 18446744073709551616 wei"));
        for v in &all {
            let m = render(v);
            assert!(!m.ends_with(b"\n"));
            assert_eq!(m.iter().filter(|b| **b == b'\n').count(), 7);
        }
    }

    #[test]
    fn rfq_message_changes_with_every_field() {
        let base = &vectors()[0];
        let r0 = render(base);
        let edits: [fn(&mut Vector); 7] = [
            |v| v.program_id = Pubkey::new_from_array([9; 32]),
            |v| v.user = Pubkey::new_from_array([9; 32]),
            |v| v.nonce += 1,
            |v| v.deadline += 1,
            |v| v.sell_lamports += 1,
            |v| v.min_out_wei += 1,
            |v| v.recipient[0] ^= 1,
        ];
        for edit in edits {
            let mut v = vectors().remove(0);
            edit(&mut v);
            assert_ne!(render(&v), r0);
        }
    }

    #[test]
    fn base58_matches_pubkey_display() {
        let mut keys = vec![
            crate::ID,
            Pubkey::new_from_array([0; 32]),
            Pubkey::new_from_array([255; 32]),
            pubkey!("D5pwjGzqvgvuFt4rtMVf1ta4RKXWyGGfG2ekh5KuDfZw"),
            pubkey!("11111111111111111111111111111112"),
        ];
        let mut lead = [0x42u8; 32];
        lead[..3].copy_from_slice(&[0, 0, 0]);
        keys.push(Pubkey::new_from_array(lead));
        for i in 0..200u32 {
            keys.push(Pubkey::new_unique());
            let mut b = [0u8; 32];
            b[(i % 32) as usize] = i as u8;
            keys.push(Pubkey::new_from_array(b));
        }
        for k in keys {
            assert_eq!(
                String::from_utf8(base58_32(k.as_ref())).unwrap(),
                k.to_string()
            );
        }
    }

    #[test]
    fn deadline_window() {
        let now = 1_759_830_000;
        assert!(check_deadline(now, now).is_ok());
        assert!(check_deadline(now, now + MAX_DEADLINE_SECS).is_ok());
        assert_eq!(
            check_deadline(now, now - 1).unwrap_err(),
            error!(IntentsError::DeadlinePassed)
        );
        assert_eq!(
            check_deadline(now, now + MAX_DEADLINE_SECS + 1).unwrap_err(),
            error!(IntentsError::DeadlineTooFar)
        );
        assert!(check_deadline(i64::MAX - 5, i64::MAX).is_ok());
    }

    // ------------------------------------------------ ed25519 instruction data

    const PK: [u8; 32] = [0xa1; 32];
    const SIG: [u8; 64] = [0x5e; 64];

    /// Layout of `Ed25519Program.createInstructionWithPublicKey` (web3.js) and
    /// `new_ed25519_instruction_with_signature`: header, offsets, pk, sig, msg.
    fn ed25519_data(msg: &[u8]) -> Vec<u8> {
        let pk_off = 16u16;
        let sig_off = pk_off + 32;
        let msg_off = sig_off + 64;
        let mut d = vec![1u8, 0];
        for v in [
            sig_off,
            u16::MAX,
            pk_off,
            u16::MAX,
            msg_off,
            msg.len() as u16,
            u16::MAX,
        ] {
            d.extend_from_slice(&v.to_le_bytes());
        }
        d.extend_from_slice(&PK);
        d.extend_from_slice(&SIG);
        d.extend_from_slice(msg);
        d
    }

    fn set_u16(d: &mut [u8], field: usize, v: u16) {
        let at = ED25519_OFFSETS_START + field * 2;
        d[at..at + 2].copy_from_slice(&v.to_le_bytes());
    }

    fn invalid() -> Error {
        error!(IntentsError::InvalidSignatureInstruction)
    }

    #[test]
    fn ed25519_parses_through_offsets() {
        let d = ed25519_data(b"hello");
        let e = parse_ed25519_single(&d).unwrap();
        assert_eq!(e.public_key, &PK);
        assert_eq!(e.signature, &SIG);
        assert_eq!(e.message, b"hello");
        // Offsets are honoured, not assumed: point the message at the pk bytes.
        let mut moved = d.clone();
        set_u16(&mut moved, 4, 16);
        set_u16(&mut moved, 5, 3);
        assert_eq!(parse_ed25519_single(&moved).unwrap().message, &PK[..3]);
        // Empty message ending exactly at the end of data is in bounds.
        let mut empty = d;
        let end = empty.len() as u16;
        set_u16(&mut empty, 4, end);
        set_u16(&mut empty, 5, 0);
        assert_eq!(parse_ed25519_single(&empty).unwrap().message, b"");
    }

    #[test]
    fn ed25519_rejects_signature_count_other_than_one() {
        for n in [0u8, 2, 255] {
            let mut d = ed25519_data(b"m");
            d[0] = n;
            assert_eq!(
                parse_ed25519_single(&d).unwrap_err(),
                invalid(),
                "num_signatures {n}"
            );
        }
    }

    #[test]
    fn ed25519_rejects_instruction_index_other_than_self() {
        // fields: 1 signature_instruction_index, 3 public_key_.., 6 message_..
        for field in [1usize, 3, 6] {
            for idx in [0u16, 1, 2, u16::MAX - 1] {
                let mut d = ed25519_data(b"m");
                set_u16(&mut d, field, idx);
                assert_eq!(
                    parse_ed25519_single(&d).unwrap_err(),
                    invalid(),
                    "field {field} = {idx}"
                );
            }
        }
    }

    #[test]
    fn ed25519_rejects_out_of_bounds_offsets() {
        let d = ed25519_data(b"message");
        let len = d.len() as u16;
        let cases: [(usize, u16); 8] = [
            (0, len - 63), // signature runs one byte past the end
            (0, u16::MAX), // signature offset far past the end
            (2, len - 31), // public key runs past the end
            (2, u16::MAX),
            (4, len - 6),  // message (7 bytes) runs past the end
            (4, u16::MAX), // offset + size overflows u16 but not usize
            (5, 8),        // message size one past the end
            (5, u16::MAX),
        ];
        for (field, v) in cases {
            let mut bad = d.clone();
            set_u16(&mut bad, field, v);
            assert_eq!(
                parse_ed25519_single(&bad).unwrap_err(),
                invalid(),
                "field {field} = {v}"
            );
        }
        for short in [0usize, 1, 2, 15] {
            assert_eq!(
                parse_ed25519_single(&d[..short]).unwrap_err(),
                invalid(),
                "len {short}"
            );
        }
    }

    #[test]
    fn ed25519_ix_must_match_program_signer_and_message() {
        let signer = Pubkey::new_from_array(PK);
        let ix = Instruction {
            program_id: solana_program::ed25519_program::ID,
            accounts: vec![],
            data: ed25519_data(b"msg"),
        };
        assert!(check_ed25519_ix(&ix, &signer, b"msg").is_ok());
        let mismatch = error!(IntentsError::SignatureMismatch);
        assert_eq!(
            check_ed25519_ix(&ix, &signer, b"msh").unwrap_err(),
            mismatch
        );
        assert_eq!(
            check_ed25519_ix(&ix, &signer, b"msg2").unwrap_err(),
            mismatch
        );
        assert_eq!(check_ed25519_ix(&ix, &signer, b"ms").unwrap_err(), mismatch);
        let other = Pubkey::new_from_array([2; 32]);
        assert_eq!(check_ed25519_ix(&ix, &other, b"msg").unwrap_err(), mismatch);
        // Same bytes under any other program (e.g. secp256k1, or a fake) are refused.
        let mut fake = ix.clone();
        fake.program_id = solana_program::secp256k1_program::ID;
        assert_eq!(
            check_ed25519_ix(&fake, &signer, b"msg").unwrap_err(),
            invalid()
        );
        fake.program_id = crate::ID;
        assert_eq!(
            check_ed25519_ix(&fake, &signer, b"msg").unwrap_err(),
            invalid()
        );
    }
}
