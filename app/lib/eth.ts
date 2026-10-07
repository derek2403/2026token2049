// EIP-55 checksum addresses (https://eips.ethereum.org/EIPS/eip-55).

import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

export function toChecksumAddress(addr: string | Uint8Array): string {
  const lower = (typeof addr === "string" ? addr.replace(/^0x/i, "") : bytesToHex(addr)).toLowerCase();
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

export type AddressCheck =
  | { ok: true; checksummed: string; bytes: Uint8Array; hasChecksum: boolean }
  | { ok: false; error: string };

/** Mixed case must match EIP-55; all-lower or all-upper is valid but unchecksummed. */
export function checkEvmAddress(input: string): AddressCheck {
  const s = input.trim();
  if (s === "") return { ok: false, error: "Enter a Base address" };
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return { ok: false, error: "Not a 0x address (40 hex characters)" };
  const body = s.slice(2);
  const checksummed = toChecksumAddress(s);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && s !== checksummed) return { ok: false, error: "Checksum mismatch (EIP-55): check for a typo" };
  if (/^0x0{40}$/.test(s)) return { ok: false, error: "Zero address" };
  return { ok: true, checksummed, bytes: hexToBytes(body.toLowerCase()), hasChecksum: mixed };
}
