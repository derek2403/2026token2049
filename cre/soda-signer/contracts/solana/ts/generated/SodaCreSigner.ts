// Code generated — DO NOT EDIT.
import {
  getArrayCodec,
  getStructCodec,
  getU8Codec,
} from '@solana/codecs'
import { getAddressCodec, type Address } from '@solana/addresses'
import {
  adaptTrigger,
  anchorCPILogTriggerConfig,
  bytesToBase64,
  bytesToHex,
  calculateAccountsHash,
  encodeBorshVecU32,
  encodeForwarderReport,
  prepareSolanaReportRequest,
  type Runtime,
  type SolanaAccountMeta,
  SolanaClient,
  solanaAccountMetasToJson,
  solanaAddressToBytes,
  type SolanaComputeConfig,
  type SolanaDecodedLog,
  type SolanaFilterLogTriggerRequestJson,
  type SolanaLog,
  type SolanaLogTriggerOptions,
  type SolanaSubkeyConfigJson,
  type SolanaValueComparatorJson,
  type Trigger,
} from '@chainlink/cre-sdk'

export const SODA_CRE_SIGNER_PROGRAM_ID = '2cgtuK2Y9BQ8uMbVpYwM9FZ7TVkSqu9xegNTyBp3taxM'

export const SODA_CRE_SIGNER_IDL = {"address":"2cgtuK2Y9BQ8uMbVpYwM9FZ7TVkSqu9xegNTyBp3taxM","metadata":{"name":"soda_cre_signer","version":"0.1.0","spec":"0.1.0"},"instructions":[{"name":"init_config","discriminator":[23,235,115,232,168,96,1,231],"accounts":[{"name":"admin","writable":true,"signer":true,"address":"57Y6siThZ6JUjjpgQ7JT7JUFVk4e1xcAsCDRHJBQUXkE"},{"name":"config","writable":true,"pda":{"seeds":[{"kind":"const","value":[99,111,110,102,105,103]}]}},{"name":"system_program","address":"11111111111111111111111111111111"}],"args":[{"name":"forwarder_program","type":"pubkey"},{"name":"forwarder_state","type":"pubkey"}]},{"name":"on_report","docs":["Called by the keystone forwarder via CPI; the name fixes the","discriminator to [214,173,18,221,173,148,151,208]."],"discriminator":[214,173,18,221,173,148,151,208],"accounts":[{"name":"state"},{"name":"forwarder_authority","docs":["PDA [\"forwarder\", state, this program] under the forwarder; checked in on_report."],"signer":true},{"name":"config","pda":{"seeds":[{"kind":"const","value":[99,111,110,102,105,103]}]}},{"name":"sig_request","writable":true},{"name":"committee","address":"9mX3oHUmsrYvzXjCo35HhfXufrGZT3hjsLoC74xbA6SS"},{"name":"submitter","pda":{"seeds":[{"kind":"const","value":[115,117,98,109,105,116,116,101,114]}]}},{"name":"soda_program","address":"CPAEfBXpMMsUrjLNhDYxaCH79DYvFHJFC27fttnxAL1J"}],"args":[{"name":"metadata","type":"bytes"},{"name":"report","type":"bytes"}]},{"name":"set_config","docs":["Switches between the mock and production forwarders."],"discriminator":[108,158,154,175,212,98,52,66],"accounts":[{"name":"admin","signer":true,"address":"57Y6siThZ6JUjjpgQ7JT7JUFVk4e1xcAsCDRHJBQUXkE","relations":["config"]},{"name":"config","writable":true,"pda":{"seeds":[{"kind":"const","value":[99,111,110,102,105,103]}]}}],"args":[{"name":"forwarder_program","type":"pubkey"},{"name":"forwarder_state","type":"pubkey"}]}],"accounts":[{"name":"Config","discriminator":[155,12,170,224,30,250,204,130]}],"events":[{"name":"AlreadyFinalized","discriminator":[205,215,32,188,138,175,150,241]},{"name":"CreFinalized","discriminator":[133,146,123,246,63,143,159,231]}],"errors":[{"code":6000,"name":"NotAdmin","msg":"Signer is not the admin"},{"code":6001,"name":"MismatchedForwarderProgram","msg":"Forwarder state is not owned by config.forwarder_program"},{"code":6002,"name":"InvalidForwarderState","msg":"Forwarder state is not config.forwarder_state"},{"code":6003,"name":"InvalidForwarderAuthority","msg":"forwarder_authority is not the PDA for this state, receiver and forwarder program"},{"code":6004,"name":"InvalidMetadataLength","msg":"Metadata must be 64 bytes"},{"code":6005,"name":"InvalidReportLength","msg":"Report must be a 98-byte Borsh SignerReport"},{"code":6006,"name":"UnsupportedReportVersion","msg":"Unsupported SignerReport version"},{"code":6007,"name":"SigRequestMismatch","msg":"sig_request account does not match the report"},{"code":6008,"name":"InvalidSigRequest","msg":"sig_request is not a valid soda SigRequest"},{"code":6009,"name":"InvalidCommittee","msg":"committee is not the soda committee"},{"code":6010,"name":"InvalidSodaProgram","msg":"soda_program is not soda"}],"types":[{"name":"AlreadyFinalized","type":{"kind":"struct","fields":[{"name":"sig_request","type":"pubkey"}]}},{"name":"Config","type":{"kind":"struct","fields":[{"name":"admin","type":"pubkey"},{"name":"forwarder_program","type":"pubkey"},{"name":"forwarder_state","type":"pubkey"},{"name":"bump","type":"u8"}]}},{"name":"CreFinalized","docs":["Also puts `SignerReport` in the IDL, which `cre generate-bindings` needs."],"type":{"kind":"struct","fields":[{"name":"report","type":{"defined":{"name":"SignerReport"}}}]}},{"name":"SignerReport","docs":["Borsh payload the CRE workflow writes (98 bytes)."],"type":{"kind":"struct","fields":[{"name":"ver","type":"u8"},{"name":"sig_request","type":"pubkey"},{"name":"signature","docs":["r || s"],"type":{"array":["u8",64]}},{"name":"recovery_id","type":"u8"}]}}]} as const

// Base64 of the compact IDL JSON, passed to log triggers as contractIdlJson.
const SODA_CRE_SIGNER_IDL_BASE64 = 'eyJhZGRyZXNzIjoiMmNndHVLMlk5QlE4dU1iVnBZd005Rlo3VFZrU3F1OXhlZ05UeUJwM3RheE0iLCJtZXRhZGF0YSI6eyJuYW1lIjoic29kYV9jcmVfc2lnbmVyIiwidmVyc2lvbiI6IjAuMS4wIiwic3BlYyI6IjAuMS4wIn0sImluc3RydWN0aW9ucyI6W3sibmFtZSI6ImluaXRfY29uZmlnIiwiZGlzY3JpbWluYXRvciI6WzIzLDIzNSwxMTUsMjMyLDE2OCw5NiwxLDIzMV0sImFjY291bnRzIjpbeyJuYW1lIjoiYWRtaW4iLCJ3cml0YWJsZSI6dHJ1ZSwic2lnbmVyIjp0cnVlLCJhZGRyZXNzIjoiNTdZNnNpVGhaNkpVampwZ1E3SlQ3SlVGVms0ZTF4Y0FzQ0RSSEpCUVVYa0UifSx7Im5hbWUiOiJjb25maWciLCJ3cml0YWJsZSI6dHJ1ZSwicGRhIjp7InNlZWRzIjpbeyJraW5kIjoiY29uc3QiLCJ2YWx1ZSI6Wzk5LDExMSwxMTAsMTAyLDEwNSwxMDNdfV19fSx7Im5hbWUiOiJzeXN0ZW1fcHJvZ3JhbSIsImFkZHJlc3MiOiIxMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMSJ9XSwiYXJncyI6W3sibmFtZSI6ImZvcndhcmRlcl9wcm9ncmFtIiwidHlwZSI6InB1YmtleSJ9LHsibmFtZSI6ImZvcndhcmRlcl9zdGF0ZSIsInR5cGUiOiJwdWJrZXkifV19LHsibmFtZSI6Im9uX3JlcG9ydCIsImRvY3MiOlsiQ2FsbGVkIGJ5IHRoZSBrZXlzdG9uZSBmb3J3YXJkZXIgdmlhIENQSTsgdGhlIG5hbWUgZml4ZXMgdGhlIiwiZGlzY3JpbWluYXRvciB0byBbMjE0LDE3MywxOCwyMjEsMTczLDE0OCwxNTEsMjA4XS4iXSwiZGlzY3JpbWluYXRvciI6WzIxNCwxNzMsMTgsMjIxLDE3MywxNDgsMTUxLDIwOF0sImFjY291bnRzIjpbeyJuYW1lIjoic3RhdGUifSx7Im5hbWUiOiJmb3J3YXJkZXJfYXV0aG9yaXR5IiwiZG9jcyI6WyJQREEgW1wiZm9yd2FyZGVyXCIsIHN0YXRlLCB0aGlzIHByb2dyYW1dIHVuZGVyIHRoZSBmb3J3YXJkZXI7IGNoZWNrZWQgaW4gb25fcmVwb3J0LiJdLCJzaWduZXIiOnRydWV9LHsibmFtZSI6ImNvbmZpZyIsInBkYSI6eyJzZWVkcyI6W3sia2luZCI6ImNvbnN0IiwidmFsdWUiOls5OSwxMTEsMTEwLDEwMiwxMDUsMTAzXX1dfX0seyJuYW1lIjoic2lnX3JlcXVlc3QiLCJ3cml0YWJsZSI6dHJ1ZX0seyJuYW1lIjoiY29tbWl0dGVlIiwiYWRkcmVzcyI6IjltWDNvSFVtc3JZdnpYakNvMzVIaGZYdWZyR1pUM2hqc0xvQzc0eGJBNlNTIn0seyJuYW1lIjoic3VibWl0dGVyIiwicGRhIjp7InNlZWRzIjpbeyJraW5kIjoiY29uc3QiLCJ2YWx1ZSI6WzExNSwxMTcsOTgsMTA5LDEwNSwxMTYsMTE2LDEwMSwxMTRdfV19fSx7Im5hbWUiOiJzb2RhX3Byb2dyYW0iLCJhZGRyZXNzIjoiQ1BBRWZCWHBNTXNVcmpMTmhEWXhhQ0g3OURZdkZISkZDMjdmdHRueEFMMUoifV0sImFyZ3MiOlt7Im5hbWUiOiJtZXRhZGF0YSIsInR5cGUiOiJieXRlcyJ9LHsibmFtZSI6InJlcG9ydCIsInR5cGUiOiJieXRlcyJ9XX0seyJuYW1lIjoic2V0X2NvbmZpZyIsImRvY3MiOlsiU3dpdGNoZXMgYmV0d2VlbiB0aGUgbW9jayBhbmQgcHJvZHVjdGlvbiBmb3J3YXJkZXJzLiJdLCJkaXNjcmltaW5hdG9yIjpbMTA4LDE1OCwxNTQsMTc1LDIxMiw5OCw1Miw2Nl0sImFjY291bnRzIjpbeyJuYW1lIjoiYWRtaW4iLCJzaWduZXIiOnRydWUsImFkZHJlc3MiOiI1N1k2c2lUaFo2SlVqanBnUTdKVDdKVUZWazRlMXhjQXNDRFJISkJRVVhrRSIsInJlbGF0aW9ucyI6WyJjb25maWciXX0seyJuYW1lIjoiY29uZmlnIiwid3JpdGFibGUiOnRydWUsInBkYSI6eyJzZWVkcyI6W3sia2luZCI6ImNvbnN0IiwidmFsdWUiOls5OSwxMTEsMTEwLDEwMiwxMDUsMTAzXX1dfX1dLCJhcmdzIjpbeyJuYW1lIjoiZm9yd2FyZGVyX3Byb2dyYW0iLCJ0eXBlIjoicHVia2V5In0seyJuYW1lIjoiZm9yd2FyZGVyX3N0YXRlIiwidHlwZSI6InB1YmtleSJ9XX1dLCJhY2NvdW50cyI6W3sibmFtZSI6IkNvbmZpZyIsImRpc2NyaW1pbmF0b3IiOlsxNTUsMTIsMTcwLDIyNCwzMCwyNTAsMjA0LDEzMF19XSwiZXZlbnRzIjpbeyJuYW1lIjoiQWxyZWFkeUZpbmFsaXplZCIsImRpc2NyaW1pbmF0b3IiOlsyMDUsMjE1LDMyLDE4OCwxMzgsMTc1LDE1MCwyNDFdfSx7Im5hbWUiOiJDcmVGaW5hbGl6ZWQiLCJkaXNjcmltaW5hdG9yIjpbMTMzLDE0NiwxMjMsMjQ2LDYzLDE0MywxNTksMjMxXX1dLCJlcnJvcnMiOlt7ImNvZGUiOjYwMDAsIm5hbWUiOiJOb3RBZG1pbiIsIm1zZyI6IlNpZ25lciBpcyBub3QgdGhlIGFkbWluIn0seyJjb2RlIjo2MDAxLCJuYW1lIjoiTWlzbWF0Y2hlZEZvcndhcmRlclByb2dyYW0iLCJtc2ciOiJGb3J3YXJkZXIgc3RhdGUgaXMgbm90IG93bmVkIGJ5IGNvbmZpZy5mb3J3YXJkZXJfcHJvZ3JhbSJ9LHsiY29kZSI6NjAwMiwibmFtZSI6IkludmFsaWRGb3J3YXJkZXJTdGF0ZSIsIm1zZyI6IkZvcndhcmRlciBzdGF0ZSBpcyBub3QgY29uZmlnLmZvcndhcmRlcl9zdGF0ZSJ9LHsiY29kZSI6NjAwMywibmFtZSI6IkludmFsaWRGb3J3YXJkZXJBdXRob3JpdHkiLCJtc2ciOiJmb3J3YXJkZXJfYXV0aG9yaXR5IGlzIG5vdCB0aGUgUERBIGZvciB0aGlzIHN0YXRlLCByZWNlaXZlciBhbmQgZm9yd2FyZGVyIHByb2dyYW0ifSx7ImNvZGUiOjYwMDQsIm5hbWUiOiJJbnZhbGlkTWV0YWRhdGFMZW5ndGgiLCJtc2ciOiJNZXRhZGF0YSBtdXN0IGJlIDY0IGJ5dGVzIn0seyJjb2RlIjo2MDA1LCJuYW1lIjoiSW52YWxpZFJlcG9ydExlbmd0aCIsIm1zZyI6IlJlcG9ydCBtdXN0IGJlIGEgOTgtYnl0ZSBCb3JzaCBTaWduZXJSZXBvcnQifSx7ImNvZGUiOjYwMDYsIm5hbWUiOiJVbnN1cHBvcnRlZFJlcG9ydFZlcnNpb24iLCJtc2ciOiJVbnN1cHBvcnRlZCBTaWduZXJSZXBvcnQgdmVyc2lvbiJ9LHsiY29kZSI6NjAwNywibmFtZSI6IlNpZ1JlcXVlc3RNaXNtYXRjaCIsIm1zZyI6InNpZ19yZXF1ZXN0IGFjY291bnQgZG9lcyBub3QgbWF0Y2ggdGhlIHJlcG9ydCJ9LHsiY29kZSI6NjAwOCwibmFtZSI6IkludmFsaWRTaWdSZXF1ZXN0IiwibXNnIjoic2lnX3JlcXVlc3QgaXMgbm90IGEgdmFsaWQgc29kYSBTaWdSZXF1ZXN0In0seyJjb2RlIjo2MDA5LCJuYW1lIjoiSW52YWxpZENvbW1pdHRlZSIsIm1zZyI6ImNvbW1pdHRlZSBpcyBub3QgdGhlIHNvZGEgY29tbWl0dGVlIn0seyJjb2RlIjo2MDEwLCJuYW1lIjoiSW52YWxpZFNvZGFQcm9ncmFtIiwibXNnIjoic29kYV9wcm9ncmFtIGlzIG5vdCBzb2RhIn1dLCJ0eXBlcyI6W3sibmFtZSI6IkFscmVhZHlGaW5hbGl6ZWQiLCJ0eXBlIjp7ImtpbmQiOiJzdHJ1Y3QiLCJmaWVsZHMiOlt7Im5hbWUiOiJzaWdfcmVxdWVzdCIsInR5cGUiOiJwdWJrZXkifV19fSx7Im5hbWUiOiJDb25maWciLCJ0eXBlIjp7ImtpbmQiOiJzdHJ1Y3QiLCJmaWVsZHMiOlt7Im5hbWUiOiJhZG1pbiIsInR5cGUiOiJwdWJrZXkifSx7Im5hbWUiOiJmb3J3YXJkZXJfcHJvZ3JhbSIsInR5cGUiOiJwdWJrZXkifSx7Im5hbWUiOiJmb3J3YXJkZXJfc3RhdGUiLCJ0eXBlIjoicHVia2V5In0seyJuYW1lIjoiYnVtcCIsInR5cGUiOiJ1OCJ9XX19LHsibmFtZSI6IkNyZUZpbmFsaXplZCIsImRvY3MiOlsiQWxzbyBwdXRzIGBTaWduZXJSZXBvcnRgIGluIHRoZSBJREwsIHdoaWNoIGBjcmUgZ2VuZXJhdGUtYmluZGluZ3NgIG5lZWRzLiJdLCJ0eXBlIjp7ImtpbmQiOiJzdHJ1Y3QiLCJmaWVsZHMiOlt7Im5hbWUiOiJyZXBvcnQiLCJ0eXBlIjp7ImRlZmluZWQiOnsibmFtZSI6IlNpZ25lclJlcG9ydCJ9fX1dfX0seyJuYW1lIjoiU2lnbmVyUmVwb3J0IiwiZG9jcyI6WyJCb3JzaCBwYXlsb2FkIHRoZSBDUkUgd29ya2Zsb3cgd3JpdGVzICg5OCBieXRlcykuIl0sInR5cGUiOnsia2luZCI6InN0cnVjdCIsImZpZWxkcyI6W3sibmFtZSI6InZlciIsInR5cGUiOiJ1OCJ9LHsibmFtZSI6InNpZ19yZXF1ZXN0IiwidHlwZSI6InB1YmtleSJ9LHsibmFtZSI6InNpZ25hdHVyZSIsImRvY3MiOlsiciB8fCBzIl0sInR5cGUiOnsiYXJyYXkiOlsidTgiLDY0XX19LHsibmFtZSI6InJlY292ZXJ5X2lkIiwidHlwZSI6InU4In1dfX1dfQ=='

const DISCRIMINATOR_SIZE = 8

const expectDiscriminator = (label: string, expected: Uint8Array, data: Uint8Array): Uint8Array => {
  if (data.length < DISCRIMINATOR_SIZE) {
    throw new Error(`${label}: data too short for discriminator (${data.length} bytes)`)
  }
  for (let i = 0; i < DISCRIMINATOR_SIZE; i++) {
    if (data[i] !== expected[i]) {
      throw new Error(`${label}: discriminator mismatch`)
    }
  }
  return data.subarray(DISCRIMINATOR_SIZE)
}

export type AlreadyFinalized = {
  sigRequest: Address
}

export const alreadyFinalizedCodec = getStructCodec([
  ['sigRequest', getAddressCodec()],
])

export type Config = {
  admin: Address
  forwarderProgram: Address
  forwarderState: Address
  bump: number
}

export const configCodec = getStructCodec([
  ['admin', getAddressCodec()],
  ['forwarderProgram', getAddressCodec()],
  ['forwarderState', getAddressCodec()],
  ['bump', getU8Codec()],
])

export type SignerReport = {
  ver: number
  sigRequest: Address
  signature: number[]
  recoveryId: number
}

export const signerReportCodec = getStructCodec([
  ['ver', getU8Codec()],
  ['sigRequest', getAddressCodec()],
  ['signature', getArrayCodec(getU8Codec(), { size: 64 })],
  ['recoveryId', getU8Codec()],
])

export type CreFinalized = {
  report: SignerReport
}

export const creFinalizedCodec = getStructCodec([
  ['report', signerReportCodec],
])

export const ACCOUNT_CONFIG_DISCRIMINATOR = new Uint8Array([155, 12, 170, 224, 30, 250, 204, 130])

/**
 * Decodes raw Config account data (with its 8-byte discriminator) into Config.
 * Pure helper — there is no read capability; obtain the account bytes elsewhere.
 */
export const decodeConfigAccount = (data: Uint8Array): Config =>
  configCodec.decode(expectDiscriminator('account Config', ACCOUNT_CONFIG_DISCRIMINATOR, data)) as Config

export const EVENT_ALREADY_FINALIZED_DISCRIMINATOR = new Uint8Array([205, 215, 32, 188, 138, 175, 150, 241])

/**
 * Decodes raw AlreadyFinalized event data (with its 8-byte discriminator) into AlreadyFinalized.
 */
export const decodeAlreadyFinalizedEvent = (data: Uint8Array): AlreadyFinalized =>
  alreadyFinalizedCodec.decode(expectDiscriminator('event AlreadyFinalized', EVENT_ALREADY_FINALIZED_DISCRIMINATOR, data)) as AlreadyFinalized

export const EVENT_CRE_FINALIZED_DISCRIMINATOR = new Uint8Array([133, 146, 123, 246, 63, 143, 159, 231])

/**
 * Decodes raw CreFinalized event data (with its 8-byte discriminator) into CreFinalized.
 */
export const decodeCreFinalizedEvent = (data: Uint8Array): CreFinalized =>
  creFinalizedCodec.decode(expectDiscriminator('event CreFinalized', EVENT_CRE_FINALIZED_DISCRIMINATOR, data)) as CreFinalized

export const parseAnyAccount = (data: Uint8Array): Config => {
  const disc = data.subarray(0, DISCRIMINATOR_SIZE)
  const matches = (expected: Uint8Array) => expected.every((b, i) => disc[i] === b)
  if (matches(ACCOUNT_CONFIG_DISCRIMINATOR)) return decodeConfigAccount(data)
  throw new Error(`unknown account discriminator: [${Array.from(disc).join(', ')}]`)
}

export const parseAnyEvent = (data: Uint8Array): AlreadyFinalized | CreFinalized => {
  const disc = data.subarray(0, DISCRIMINATOR_SIZE)
  const matches = (expected: Uint8Array) => expected.every((b, i) => disc[i] === b)
  if (matches(EVENT_ALREADY_FINALIZED_DISCRIMINATOR)) return decodeAlreadyFinalizedEvent(data)
  if (matches(EVENT_CRE_FINALIZED_DISCRIMINATOR)) return decodeCreFinalizedEvent(data)
  throw new Error(`unknown event discriminator: [${Array.from(disc).join(', ')}]`)
}

/**
 * Optional filter values for AlreadyFinalized log triggers. Set fields in one row to
 * AND those predicates. Multiple rows are OR alternatives, but current trigger
 * configuration supports only a single row. Leave unset for wildcard. Only top-level
 * scalar fields with supported subkey encodings are auto-filterable — nested
 * structs, vecs, arrays, bool, u128, and i128 need a manual SubkeyConfig.
 */
export type AlreadyFinalizedFilters = {
  sigRequest?: Address | null
}

export const encodeAlreadyFinalizedSubkeys = (filters: AlreadyFinalizedFilters[]): SolanaSubkeyConfigJson[] => {
  if (filters.length > 1) {
    throw new Error('multiple filter rows are not supported for AlreadyFinalized; provide a single filter row')
  }
  const sigRequestComparers: SolanaValueComparatorJson[] = []
  for (const f of filters) {
    if (f.sigRequest != null) {
      sigRequestComparers.push({
        operator: 'COMPARISON_OPERATOR_EQ',
        value: bytesToBase64(solanaAddressToBytes(f.sigRequest)),
      })
    }
  }
  const subkeys: SolanaSubkeyConfigJson[] = []
  if (sigRequestComparers.length > 0) {
    subkeys.push({ path: ['SigRequest'], comparers: sigRequestComparers })
  }
  return subkeys
}

/**
 * Optional filter values for CreFinalized log triggers. Set fields in one row to
 * AND those predicates. Multiple rows are OR alternatives, but current trigger
 * configuration supports only a single row. Leave unset for wildcard. Only top-level
 * scalar fields with supported subkey encodings are auto-filterable — nested
 * structs, vecs, arrays, bool, u128, and i128 need a manual SubkeyConfig.
 */
export type CreFinalizedFilters = Record<string, never>

export const encodeCreFinalizedSubkeys = (filters: CreFinalizedFilters[]): SolanaSubkeyConfigJson[] => {
  if (filters.length > 1) {
    throw new Error('multiple filter rows are not supported for CreFinalized; provide a single filter row')
  }
  return []
}

export class SodaCreSigner {
  readonly programId: Uint8Array

  // The program ID is baked into the IDL, so it defaults to the generated
  // const — unlike EVM bindings where the address is a runtime value.
  constructor(
    private readonly client: SolanaClient,
    programId: string | Uint8Array = SODA_CRE_SIGNER_PROGRAM_ID,
  ) {
    this.programId = typeof programId === 'string' ? solanaAddressToBytes(programId) : programId
  }

  /**
   * Publishes a pre-encoded Borsh payload through the CRE signer to this
   * program's on_report entrypoint via the keystone-forwarder.
   *
   * remainingAccounts must follow the keystone-forwarder account layout:
   *   - Index 0: forwarderState – the forwarder program's state account.
   *   - Index 1: forwarderAuthority – PDA derived from seeds
   *     ["forwarder", forwarderState, receiverProgram] under the forwarder program ID.
   *   - Index 2+: receiver-specific accounts required by the target program.
   *
   * The full account list is hashed (via calculateAccountsHash) into the report.
   * The on-chain forwarder strips indices 0 and 1 before CPI-ing into the
   * receiver, so they must be present and correctly ordered.
   */
  writeReport(
    runtime: Runtime<unknown>,
    payload: Uint8Array,
    remainingAccounts: SolanaAccountMeta[],
    computeConfig?: SolanaComputeConfig,
  ) {
    const report = runtime
      .report(
        prepareSolanaReportRequest(
          encodeForwarderReport({
            accountHash: calculateAccountsHash(remainingAccounts),
            payload,
          }),
        ),
      )
      .result()

    return this.client
      .writeReport(runtime, {
        remainingAccounts: solanaAccountMetasToJson(remainingAccounts),
        receiver: bytesToHex(this.programId),
        computeConfig,
        report,
      })
      .result()
  }

  /**
   * Publishes a Borsh Vec of pre-encoded element payloads (mirrors Go's
   * WriteReportFromBorshEncodedVec). Each element must already be fully
   * serialized for one Vec item on the wire.
   */
  writeReportFromBorshEncodedVec(
    runtime: Runtime<unknown>,
    elementPayloads: Uint8Array[],
    remainingAccounts: SolanaAccountMeta[],
    computeConfig?: SolanaComputeConfig,
  ) {
    return this.writeReport(runtime, encodeBorshVecU32(elementPayloads), remainingAccounts, computeConfig)
  }

  writeReportFromAlreadyFinalized(
    runtime: Runtime<unknown>,
    input: AlreadyFinalized,
    remainingAccounts: SolanaAccountMeta[],
    computeConfig?: SolanaComputeConfig,
  ) {
    return this.writeReport(runtime, new Uint8Array(alreadyFinalizedCodec.encode(input)), remainingAccounts, computeConfig)
  }

  writeReportFromAlreadyFinalizeds(
    runtime: Runtime<unknown>,
    inputs: AlreadyFinalized[],
    remainingAccounts: SolanaAccountMeta[],
    computeConfig?: SolanaComputeConfig,
  ) {
    return this.writeReportFromBorshEncodedVec(
      runtime,
      inputs.map((input) => new Uint8Array(alreadyFinalizedCodec.encode(input))),
      remainingAccounts,
      computeConfig,
    )
  }

  writeReportFromConfig(
    runtime: Runtime<unknown>,
    input: Config,
    remainingAccounts: SolanaAccountMeta[],
    computeConfig?: SolanaComputeConfig,
  ) {
    return this.writeReport(runtime, new Uint8Array(configCodec.encode(input)), remainingAccounts, computeConfig)
  }

  writeReportFromConfigs(
    runtime: Runtime<unknown>,
    inputs: Config[],
    remainingAccounts: SolanaAccountMeta[],
    computeConfig?: SolanaComputeConfig,
  ) {
    return this.writeReportFromBorshEncodedVec(
      runtime,
      inputs.map((input) => new Uint8Array(configCodec.encode(input))),
      remainingAccounts,
      computeConfig,
    )
  }

  writeReportFromSignerReport(
    runtime: Runtime<unknown>,
    input: SignerReport,
    remainingAccounts: SolanaAccountMeta[],
    computeConfig?: SolanaComputeConfig,
  ) {
    return this.writeReport(runtime, new Uint8Array(signerReportCodec.encode(input)), remainingAccounts, computeConfig)
  }

  writeReportFromSignerReports(
    runtime: Runtime<unknown>,
    inputs: SignerReport[],
    remainingAccounts: SolanaAccountMeta[],
    computeConfig?: SolanaComputeConfig,
  ) {
    return this.writeReportFromBorshEncodedVec(
      runtime,
      inputs.map((input) => new Uint8Array(signerReportCodec.encode(input))),
      remainingAccounts,
      computeConfig,
    )
  }

  writeReportFromCreFinalized(
    runtime: Runtime<unknown>,
    input: CreFinalized,
    remainingAccounts: SolanaAccountMeta[],
    computeConfig?: SolanaComputeConfig,
  ) {
    return this.writeReport(runtime, new Uint8Array(creFinalizedCodec.encode(input)), remainingAccounts, computeConfig)
  }

  writeReportFromCreFinalizeds(
    runtime: Runtime<unknown>,
    inputs: CreFinalized[],
    remainingAccounts: SolanaAccountMeta[],
    computeConfig?: SolanaComputeConfig,
  ) {
    return this.writeReportFromBorshEncodedVec(
      runtime,
      inputs.map((input) => new Uint8Array(creFinalizedCodec.encode(input))),
      remainingAccounts,
      computeConfig,
    )
  }

  /**
   * Registers a typed log trigger for AlreadyFinalized events. The trigger
   * output is adapted to the decoded AlreadyFinalized data alongside the raw log.
   * Pass opts.cpi for events emitted via Anchor's emit_cpi!.
   */
  logTriggerAlreadyFinalizedLog(
    filterName: string,
    filters: AlreadyFinalizedFilters[] = [],
    opts?: SolanaLogTriggerOptions,
  ): Trigger<SolanaLog, SolanaDecodedLog<AlreadyFinalized>> {
    const config: SolanaFilterLogTriggerRequestJson = {
      name: filterName,
      address: bytesToBase64(this.programId),
      eventName: 'AlreadyFinalized',
      contractIdlJson: SODA_CRE_SIGNER_IDL_BASE64,
      subkeys: encodeAlreadyFinalizedSubkeys(filters),
    }
    if (opts?.cpi) {
      config.cpiFilterConfig = anchorCPILogTriggerConfig(this.programId)
    }
    return adaptTrigger(this.client.logTrigger(config), (log) => ({
      log,
      data: decodeAlreadyFinalizedEvent(log.data),
    }))
  }

  /**
   * Registers a typed log trigger for CreFinalized events. The trigger
   * output is adapted to the decoded CreFinalized data alongside the raw log.
   * Pass opts.cpi for events emitted via Anchor's emit_cpi!.
   */
  logTriggerCreFinalizedLog(
    filterName: string,
    filters: CreFinalizedFilters[] = [],
    opts?: SolanaLogTriggerOptions,
  ): Trigger<SolanaLog, SolanaDecodedLog<CreFinalized>> {
    const config: SolanaFilterLogTriggerRequestJson = {
      name: filterName,
      address: bytesToBase64(this.programId),
      eventName: 'CreFinalized',
      contractIdlJson: SODA_CRE_SIGNER_IDL_BASE64,
      subkeys: encodeCreFinalizedSubkeys(filters),
    }
    if (opts?.cpi) {
      config.cpiFilterConfig = anchorCPILogTriggerConfig(this.programId)
    }
    return adaptTrigger(this.client.logTrigger(config), (log) => ({
      log,
      data: decodeCreFinalizedEvent(log.data),
    }))
  }
}
