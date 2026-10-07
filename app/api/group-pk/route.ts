// GET /api/group-pk: the live soda Committee group_pk, so the page derives
// addresses from the key the committee actually signs with.

import { connection as requestTime } from "next/server";
import { bytesToHex } from "@noble/hashes/utils";
import { COMMITTEE_PDA, SODA_PROGRAM_ID, accountDiscriminator, equalBytes } from "@/lib/intents";
import type { ApiError, GroupPkResponse } from "@/app/lib/api-types";
import { publicError, serverConnection } from "@/app/lib/server/solana";

const TTL_MS = 10 * 60_000;
// Committee: disc(8) | bump u8 | authority Pubkey | group_pk [u8;33] | signer_count u8
const GROUP_PK_OFFSET = 8 + 1 + 32;

let cached: GroupPkResponse | null = null;

export async function GET() {
  await requestTime();
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return Response.json(cached);
  try {
    const info = await serverConnection().getAccountInfo(COMMITTEE_PDA);
    if (!info) throw new Error("Committee account not found");
    if (!info.owner.equals(SODA_PROGRAM_ID)) throw new Error("Committee account is not owned by soda");
    if (!equalBytes(info.data.subarray(0, 8), accountDiscriminator("Committee"))) {
      throw new Error("Committee account discriminator mismatch");
    }
    const pk = info.data.subarray(GROUP_PK_OFFSET, GROUP_PK_OFFSET + 33);
    if (pk[0] !== 2 && pk[0] !== 3) throw new Error("group_pk is not a compressed secp256k1 key");
    cached = { groupPk: bytesToHex(pk), committee: COMMITTEE_PDA.toBase58(), fetchedAt: Date.now() };
    return Response.json(cached);
  } catch (e) {
    // A stale key beats none; the committee is not rotated during the hackathon.
    if (cached) return Response.json(cached);
    return Response.json({ error: `Could not read the soda Committee: ${publicError(e)}` } satisfies ApiError, {
      status: 502,
    });
  }
}
