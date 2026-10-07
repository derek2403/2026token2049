// Code generated — DO NOT EDIT.
import { addSolanaContractMock, type SolanaContractMock, type SolanaMock } from '@chainlink/cre-sdk/test'

import { SODA_CRE_SIGNER_PROGRAM_ID } from './SodaCreSigner'

export type SodaCreSignerMock = SolanaContractMock

/**
 * Registers a SodaCreSigner program mock on a SolanaMock instance.
 * The Solana CRE capability is write-only, so the mock routes writeReport
 * calls targeting this program's ID; set the returned mock's writeReport
 * property to define the reply.
 */
export function newSodaCreSignerMock(
  solanaMock: SolanaMock,
  programId: string | Uint8Array = SODA_CRE_SIGNER_PROGRAM_ID,
): SodaCreSignerMock {
  return addSolanaContractMock(solanaMock, { programId })
}
