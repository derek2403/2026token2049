// Code generated — DO NOT EDIT.
import { addSolanaContractMock, type SolanaContractMock, type SolanaMock } from '@chainlink/cre-sdk/test'

import { SODA_WITNESS_PROGRAM_ID } from './SodaWitness'

export type SodaWitnessMock = SolanaContractMock

/**
 * Registers a SodaWitness program mock on a SolanaMock instance.
 * The Solana CRE capability is write-only, so the mock routes writeReport
 * calls targeting this program's ID; set the returned mock's writeReport
 * property to define the reply.
 */
export function newSodaWitnessMock(
  solanaMock: SolanaMock,
  programId: string | Uint8Array = SODA_WITNESS_PROGRAM_ID,
): SodaWitnessMock {
  return addSolanaContractMock(solanaMock, { programId })
}
