// Code generated — DO NOT EDIT.
import {
  getArrayCodec,
  getBooleanCodec,
  getI64Codec,
  getStructCodec,
  getU128Codec,
  getU64Codec,
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
  prepareSubkeyValue,
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

export const SODA_WITNESS_PROGRAM_ID = '5v97wLYgMzyfQfpZWGQ6uPXTHh4JsJitUXPReYy2uuTp'

export const SODA_WITNESS_IDL = {"address":"5v97wLYgMzyfQfpZWGQ6uPXTHh4JsJitUXPReYy2uuTp","metadata":{"name":"soda_witness","version":"0.1.0","spec":"0.1.0"},"instructions":[{"name":"init_config","discriminator":[23,235,115,232,168,96,1,231],"accounts":[{"name":"admin","writable":true,"signer":true},{"name":"config","writable":true,"pda":{"seeds":[{"kind":"const","value":[99,111,110,102,105,103]}]}},{"name":"system_program","address":"11111111111111111111111111111111"}],"args":[{"name":"forwarder_program","type":"pubkey"},{"name":"forwarder_state","type":"pubkey"},{"name":"workflow_owner","type":{"array":["u8",20]}},{"name":"workflow_name","type":{"array":["u8",10]}}]},{"name":"on_report","docs":["Called by the keystone forwarder via CPI; the name fixes the","discriminator to [214,173,18,221,173,148,151,208]."],"discriminator":[214,173,18,221,173,148,151,208],"accounts":[{"name":"state"},{"name":"forwarder_authority","docs":["PDA [\"forwarder\", state, this program] under the forwarder; checked in on_report."],"signer":true},{"name":"config","pda":{"seeds":[{"kind":"const","value":[99,111,110,102,105,103]}]}},{"name":"claim","writable":true}],"args":[{"name":"metadata","type":"bytes"},{"name":"report","type":"bytes"}]},{"name":"open_claim","docs":["Creates the caller's Pending claim. It must exist before the report","arrives, because no payer reaches `on_report`."],"discriminator":[222,101,161,226,92,247,44,252],"accounts":[{"name":"requester","writable":true,"signer":true},{"name":"claim","writable":true,"pda":{"seeds":[{"kind":"const","value":[99,108,97,105,109]},{"kind":"account","path":"requester"},{"kind":"arg","path":"chain_id"},{"kind":"arg","path":"tx_hash"}]}},{"name":"system_program","address":"11111111111111111111111111111111"}],"args":[{"name":"chain_id","type":"u64"},{"name":"tx_hash","type":{"array":["u8",32]}}]},{"name":"set_config","docs":["Switches between the mock and production forwarders, or pins the workflow."],"discriminator":[108,158,154,175,212,98,52,66],"accounts":[{"name":"admin","signer":true,"relations":["config"]},{"name":"config","writable":true,"pda":{"seeds":[{"kind":"const","value":[99,111,110,102,105,103]}]}}],"args":[{"name":"forwarder_program","type":"pubkey"},{"name":"forwarder_state","type":"pubkey"},{"name":"workflow_owner","type":{"array":["u8",20]}},{"name":"workflow_name","type":{"array":["u8",10]}}]}],"accounts":[{"name":"Claim","discriminator":[155,70,22,176,123,215,246,102]},{"name":"Config","discriminator":[155,12,170,224,30,250,204,130]}],"events":[{"name":"ClaimOpened","discriminator":[149,209,22,4,147,156,128,152]},{"name":"ClaimRecorded","discriminator":[46,183,32,80,59,171,138,224]},{"name":"WitnessRecorded","discriminator":[167,46,15,114,190,74,3,156]}],"errors":[{"code":6000,"name":"NotAdmin","msg":"Signer is not the config admin"},{"code":6001,"name":"MismatchedForwarderProgram","msg":"Forwarder state is not owned by config.forwarder_program"},{"code":6002,"name":"InvalidForwarderState","msg":"Forwarder state is not config.forwarder_state"},{"code":6003,"name":"InvalidForwarderAuthority","msg":"forwarder_authority is not the PDA for this state, receiver and forwarder program"},{"code":6004,"name":"InvalidMetadataLength","msg":"Metadata must be 64 bytes"},{"code":6005,"name":"WorkflowOwnerMismatch","msg":"Metadata workflow_owner does not match config"},{"code":6006,"name":"WorkflowNameMismatch","msg":"Metadata workflow_name does not match config"},{"code":6007,"name":"InvalidReportLength","msg":"Report must be a 106-byte Borsh WitnessReport"},{"code":6008,"name":"UnsupportedReportVersion","msg":"Unsupported WitnessReport version"},{"code":6009,"name":"ClaimNotPending","msg":"Claim is not Pending"},{"code":6010,"name":"ChainIdMismatch","msg":"Report chain_id does not match the claim"},{"code":6011,"name":"TxHashMismatch","msg":"Report tx_hash does not match the claim"}],"types":[{"name":"Claim","type":{"kind":"struct","fields":[{"name":"requester","type":"pubkey"},{"name":"chain_id","type":"u64"},{"name":"tx_hash","type":{"array":["u8",32]}},{"name":"status","docs":["STATUS_PENDING or STATUS_RECORDED."],"type":"u8"},{"name":"from","type":{"array":["u8",20]}},{"name":"to","type":{"array":["u8",20]}},{"name":"value_wei","type":"u128"},{"name":"block","type":"u64"},{"name":"success","type":"bool"},{"name":"recorded_at","type":"i64"},{"name":"bump","type":"u8"}]}},{"name":"ClaimOpened","type":{"kind":"struct","fields":[{"name":"claim","type":"pubkey"},{"name":"requester","type":"pubkey"},{"name":"chain_id","type":"u64"},{"name":"tx_hash","type":{"array":["u8",32]}}]}},{"name":"ClaimRecorded","type":{"kind":"struct","fields":[{"name":"claim","type":"pubkey"},{"name":"requester","type":"pubkey"},{"name":"success","type":"bool"}]}},{"name":"Config","type":{"kind":"struct","fields":[{"name":"admin","type":"pubkey"},{"name":"forwarder_program","type":"pubkey"},{"name":"forwarder_state","type":"pubkey"},{"name":"workflow_owner","docs":["All zeros skips the check."],"type":{"array":["u8",20]}},{"name":"workflow_name","docs":["All zeros skips the check."],"type":{"array":["u8",10]}},{"name":"bump","type":"u8"}]}},{"name":"WitnessRecorded","docs":["Also puts `WitnessReport` in the IDL, which `cre generate-bindings` needs."],"type":{"kind":"struct","fields":[{"name":"report","type":{"defined":{"name":"WitnessReport"}}}]}},{"name":"WitnessReport","docs":["Borsh payload the CRE workflow writes (106 bytes)."],"type":{"kind":"struct","fields":[{"name":"ver","type":"u8"},{"name":"chain_id","type":"u64"},{"name":"tx_hash","type":{"array":["u8",32]}},{"name":"from","type":{"array":["u8",20]}},{"name":"to","type":{"array":["u8",20]}},{"name":"value_wei","type":"u128"},{"name":"block","type":"u64"},{"name":"status","docs":["EVM receipt status: 1 success, 0 reverted."],"type":"u8"}]}}]} as const

// Base64 of the compact IDL JSON, passed to log triggers as contractIdlJson.
const SODA_WITNESS_IDL_BASE64 = 'eyJhZGRyZXNzIjoiNXY5N3dMWWdNenlmUWZwWldHUTZ1UFhUSGg0SnNKaXRVWFBSZVl5MnV1VHAiLCJtZXRhZGF0YSI6eyJuYW1lIjoic29kYV93aXRuZXNzIiwidmVyc2lvbiI6IjAuMS4wIiwic3BlYyI6IjAuMS4wIn0sImluc3RydWN0aW9ucyI6W3sibmFtZSI6ImluaXRfY29uZmlnIiwiZGlzY3JpbWluYXRvciI6WzIzLDIzNSwxMTUsMjMyLDE2OCw5NiwxLDIzMV0sImFjY291bnRzIjpbeyJuYW1lIjoiYWRtaW4iLCJ3cml0YWJsZSI6dHJ1ZSwic2lnbmVyIjp0cnVlfSx7Im5hbWUiOiJjb25maWciLCJ3cml0YWJsZSI6dHJ1ZSwicGRhIjp7InNlZWRzIjpbeyJraW5kIjoiY29uc3QiLCJ2YWx1ZSI6Wzk5LDExMSwxMTAsMTAyLDEwNSwxMDNdfV19fSx7Im5hbWUiOiJzeXN0ZW1fcHJvZ3JhbSIsImFkZHJlc3MiOiIxMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMSJ9XSwiYXJncyI6W3sibmFtZSI6ImZvcndhcmRlcl9wcm9ncmFtIiwidHlwZSI6InB1YmtleSJ9LHsibmFtZSI6ImZvcndhcmRlcl9zdGF0ZSIsInR5cGUiOiJwdWJrZXkifSx7Im5hbWUiOiJ3b3JrZmxvd19vd25lciIsInR5cGUiOnsiYXJyYXkiOlsidTgiLDIwXX19LHsibmFtZSI6IndvcmtmbG93X25hbWUiLCJ0eXBlIjp7ImFycmF5IjpbInU4IiwxMF19fV19LHsibmFtZSI6Im9uX3JlcG9ydCIsImRvY3MiOlsiQ2FsbGVkIGJ5IHRoZSBrZXlzdG9uZSBmb3J3YXJkZXIgdmlhIENQSTsgdGhlIG5hbWUgZml4ZXMgdGhlIiwiZGlzY3JpbWluYXRvciB0byBbMjE0LDE3MywxOCwyMjEsMTczLDE0OCwxNTEsMjA4XS4iXSwiZGlzY3JpbWluYXRvciI6WzIxNCwxNzMsMTgsMjIxLDE3MywxNDgsMTUxLDIwOF0sImFjY291bnRzIjpbeyJuYW1lIjoic3RhdGUifSx7Im5hbWUiOiJmb3J3YXJkZXJfYXV0aG9yaXR5IiwiZG9jcyI6WyJQREEgW1wiZm9yd2FyZGVyXCIsIHN0YXRlLCB0aGlzIHByb2dyYW1dIHVuZGVyIHRoZSBmb3J3YXJkZXI7IGNoZWNrZWQgaW4gb25fcmVwb3J0LiJdLCJzaWduZXIiOnRydWV9LHsibmFtZSI6ImNvbmZpZyIsInBkYSI6eyJzZWVkcyI6W3sia2luZCI6ImNvbnN0IiwidmFsdWUiOls5OSwxMTEsMTEwLDEwMiwxMDUsMTAzXX1dfX0seyJuYW1lIjoiY2xhaW0iLCJ3cml0YWJsZSI6dHJ1ZX1dLCJhcmdzIjpbeyJuYW1lIjoibWV0YWRhdGEiLCJ0eXBlIjoiYnl0ZXMifSx7Im5hbWUiOiJyZXBvcnQiLCJ0eXBlIjoiYnl0ZXMifV19LHsibmFtZSI6Im9wZW5fY2xhaW0iLCJkb2NzIjpbIkNyZWF0ZXMgdGhlIGNhbGxlcidzIFBlbmRpbmcgY2xhaW0uIEl0IG11c3QgZXhpc3QgYmVmb3JlIHRoZSByZXBvcnQiLCJhcnJpdmVzLCBiZWNhdXNlIG5vIHBheWVyIHJlYWNoZXMgYG9uX3JlcG9ydGAuIl0sImRpc2NyaW1pbmF0b3IiOlsyMjIsMTAxLDE2MSwyMjYsOTIsMjQ3LDQ0LDI1Ml0sImFjY291bnRzIjpbeyJuYW1lIjoicmVxdWVzdGVyIiwid3JpdGFibGUiOnRydWUsInNpZ25lciI6dHJ1ZX0seyJuYW1lIjoiY2xhaW0iLCJ3cml0YWJsZSI6dHJ1ZSwicGRhIjp7InNlZWRzIjpbeyJraW5kIjoiY29uc3QiLCJ2YWx1ZSI6Wzk5LDEwOCw5NywxMDUsMTA5XX0seyJraW5kIjoiYWNjb3VudCIsInBhdGgiOiJyZXF1ZXN0ZXIifSx7ImtpbmQiOiJhcmciLCJwYXRoIjoiY2hhaW5faWQifSx7ImtpbmQiOiJhcmciLCJwYXRoIjoidHhfaGFzaCJ9XX19LHsibmFtZSI6InN5c3RlbV9wcm9ncmFtIiwiYWRkcmVzcyI6IjExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExIn1dLCJhcmdzIjpbeyJuYW1lIjoiY2hhaW5faWQiLCJ0eXBlIjoidTY0In0seyJuYW1lIjoidHhfaGFzaCIsInR5cGUiOnsiYXJyYXkiOlsidTgiLDMyXX19XX0seyJuYW1lIjoic2V0X2NvbmZpZyIsImRvY3MiOlsiU3dpdGNoZXMgYmV0d2VlbiB0aGUgbW9jayBhbmQgcHJvZHVjdGlvbiBmb3J3YXJkZXJzLCBvciBwaW5zIHRoZSB3b3JrZmxvdy4iXSwiZGlzY3JpbWluYXRvciI6WzEwOCwxNTgsMTU0LDE3NSwyMTIsOTgsNTIsNjZdLCJhY2NvdW50cyI6W3sibmFtZSI6ImFkbWluIiwic2lnbmVyIjp0cnVlLCJyZWxhdGlvbnMiOlsiY29uZmlnIl19LHsibmFtZSI6ImNvbmZpZyIsIndyaXRhYmxlIjp0cnVlLCJwZGEiOnsic2VlZHMiOlt7ImtpbmQiOiJjb25zdCIsInZhbHVlIjpbOTksMTExLDExMCwxMDIsMTA1LDEwM119XX19XSwiYXJncyI6W3sibmFtZSI6ImZvcndhcmRlcl9wcm9ncmFtIiwidHlwZSI6InB1YmtleSJ9LHsibmFtZSI6ImZvcndhcmRlcl9zdGF0ZSIsInR5cGUiOiJwdWJrZXkifSx7Im5hbWUiOiJ3b3JrZmxvd19vd25lciIsInR5cGUiOnsiYXJyYXkiOlsidTgiLDIwXX19LHsibmFtZSI6IndvcmtmbG93X25hbWUiLCJ0eXBlIjp7ImFycmF5IjpbInU4IiwxMF19fV19XSwiYWNjb3VudHMiOlt7Im5hbWUiOiJDbGFpbSIsImRpc2NyaW1pbmF0b3IiOlsxNTUsNzAsMjIsMTc2LDEyMywyMTUsMjQ2LDEwMl19LHsibmFtZSI6IkNvbmZpZyIsImRpc2NyaW1pbmF0b3IiOlsxNTUsMTIsMTcwLDIyNCwzMCwyNTAsMjA0LDEzMF19XSwiZXZlbnRzIjpbeyJuYW1lIjoiQ2xhaW1PcGVuZWQiLCJkaXNjcmltaW5hdG9yIjpbMTQ5LDIwOSwyMiw0LDE0NywxNTYsMTI4LDE1Ml19LHsibmFtZSI6IkNsYWltUmVjb3JkZWQiLCJkaXNjcmltaW5hdG9yIjpbNDYsMTgzLDMyLDgwLDU5LDE3MSwxMzgsMjI0XX0seyJuYW1lIjoiV2l0bmVzc1JlY29yZGVkIiwiZGlzY3JpbWluYXRvciI6WzE2Nyw0NiwxNSwxMTQsMTkwLDc0LDMsMTU2XX1dLCJlcnJvcnMiOlt7ImNvZGUiOjYwMDAsIm5hbWUiOiJOb3RBZG1pbiIsIm1zZyI6IlNpZ25lciBpcyBub3QgdGhlIGNvbmZpZyBhZG1pbiJ9LHsiY29kZSI6NjAwMSwibmFtZSI6Ik1pc21hdGNoZWRGb3J3YXJkZXJQcm9ncmFtIiwibXNnIjoiRm9yd2FyZGVyIHN0YXRlIGlzIG5vdCBvd25lZCBieSBjb25maWcuZm9yd2FyZGVyX3Byb2dyYW0ifSx7ImNvZGUiOjYwMDIsIm5hbWUiOiJJbnZhbGlkRm9yd2FyZGVyU3RhdGUiLCJtc2ciOiJGb3J3YXJkZXIgc3RhdGUgaXMgbm90IGNvbmZpZy5mb3J3YXJkZXJfc3RhdGUifSx7ImNvZGUiOjYwMDMsIm5hbWUiOiJJbnZhbGlkRm9yd2FyZGVyQXV0aG9yaXR5IiwibXNnIjoiZm9yd2FyZGVyX2F1dGhvcml0eSBpcyBub3QgdGhlIFBEQSBmb3IgdGhpcyBzdGF0ZSwgcmVjZWl2ZXIgYW5kIGZvcndhcmRlciBwcm9ncmFtIn0seyJjb2RlIjo2MDA0LCJuYW1lIjoiSW52YWxpZE1ldGFkYXRhTGVuZ3RoIiwibXNnIjoiTWV0YWRhdGEgbXVzdCBiZSA2NCBieXRlcyJ9LHsiY29kZSI6NjAwNSwibmFtZSI6IldvcmtmbG93T3duZXJNaXNtYXRjaCIsIm1zZyI6Ik1ldGFkYXRhIHdvcmtmbG93X293bmVyIGRvZXMgbm90IG1hdGNoIGNvbmZpZyJ9LHsiY29kZSI6NjAwNiwibmFtZSI6IldvcmtmbG93TmFtZU1pc21hdGNoIiwibXNnIjoiTWV0YWRhdGEgd29ya2Zsb3dfbmFtZSBkb2VzIG5vdCBtYXRjaCBjb25maWcifSx7ImNvZGUiOjYwMDcsIm5hbWUiOiJJbnZhbGlkUmVwb3J0TGVuZ3RoIiwibXNnIjoiUmVwb3J0IG11c3QgYmUgYSAxMDYtYnl0ZSBCb3JzaCBXaXRuZXNzUmVwb3J0In0seyJjb2RlIjo2MDA4LCJuYW1lIjoiVW5zdXBwb3J0ZWRSZXBvcnRWZXJzaW9uIiwibXNnIjoiVW5zdXBwb3J0ZWQgV2l0bmVzc1JlcG9ydCB2ZXJzaW9uIn0seyJjb2RlIjo2MDA5LCJuYW1lIjoiQ2xhaW1Ob3RQZW5kaW5nIiwibXNnIjoiQ2xhaW0gaXMgbm90IFBlbmRpbmcifSx7ImNvZGUiOjYwMTAsIm5hbWUiOiJDaGFpbklkTWlzbWF0Y2giLCJtc2ciOiJSZXBvcnQgY2hhaW5faWQgZG9lcyBub3QgbWF0Y2ggdGhlIGNsYWltIn0seyJjb2RlIjo2MDExLCJuYW1lIjoiVHhIYXNoTWlzbWF0Y2giLCJtc2ciOiJSZXBvcnQgdHhfaGFzaCBkb2VzIG5vdCBtYXRjaCB0aGUgY2xhaW0ifV0sInR5cGVzIjpbeyJuYW1lIjoiQ2xhaW0iLCJ0eXBlIjp7ImtpbmQiOiJzdHJ1Y3QiLCJmaWVsZHMiOlt7Im5hbWUiOiJyZXF1ZXN0ZXIiLCJ0eXBlIjoicHVia2V5In0seyJuYW1lIjoiY2hhaW5faWQiLCJ0eXBlIjoidTY0In0seyJuYW1lIjoidHhfaGFzaCIsInR5cGUiOnsiYXJyYXkiOlsidTgiLDMyXX19LHsibmFtZSI6InN0YXR1cyIsImRvY3MiOlsiU1RBVFVTX1BFTkRJTkcgb3IgU1RBVFVTX1JFQ09SREVELiJdLCJ0eXBlIjoidTgifSx7Im5hbWUiOiJmcm9tIiwidHlwZSI6eyJhcnJheSI6WyJ1OCIsMjBdfX0seyJuYW1lIjoidG8iLCJ0eXBlIjp7ImFycmF5IjpbInU4IiwyMF19fSx7Im5hbWUiOiJ2YWx1ZV93ZWkiLCJ0eXBlIjoidTEyOCJ9LHsibmFtZSI6ImJsb2NrIiwidHlwZSI6InU2NCJ9LHsibmFtZSI6InN1Y2Nlc3MiLCJ0eXBlIjoiYm9vbCJ9LHsibmFtZSI6InJlY29yZGVkX2F0IiwidHlwZSI6Imk2NCJ9LHsibmFtZSI6ImJ1bXAiLCJ0eXBlIjoidTgifV19fSx7Im5hbWUiOiJDbGFpbU9wZW5lZCIsInR5cGUiOnsia2luZCI6InN0cnVjdCIsImZpZWxkcyI6W3sibmFtZSI6ImNsYWltIiwidHlwZSI6InB1YmtleSJ9LHsibmFtZSI6InJlcXVlc3RlciIsInR5cGUiOiJwdWJrZXkifSx7Im5hbWUiOiJjaGFpbl9pZCIsInR5cGUiOiJ1NjQifSx7Im5hbWUiOiJ0eF9oYXNoIiwidHlwZSI6eyJhcnJheSI6WyJ1OCIsMzJdfX1dfX0seyJuYW1lIjoiQ2xhaW1SZWNvcmRlZCIsInR5cGUiOnsia2luZCI6InN0cnVjdCIsImZpZWxkcyI6W3sibmFtZSI6ImNsYWltIiwidHlwZSI6InB1YmtleSJ9LHsibmFtZSI6InJlcXVlc3RlciIsInR5cGUiOiJwdWJrZXkifSx7Im5hbWUiOiJzdWNjZXNzIiwidHlwZSI6ImJvb2wifV19fSx7Im5hbWUiOiJDb25maWciLCJ0eXBlIjp7ImtpbmQiOiJzdHJ1Y3QiLCJmaWVsZHMiOlt7Im5hbWUiOiJhZG1pbiIsInR5cGUiOiJwdWJrZXkifSx7Im5hbWUiOiJmb3J3YXJkZXJfcHJvZ3JhbSIsInR5cGUiOiJwdWJrZXkifSx7Im5hbWUiOiJmb3J3YXJkZXJfc3RhdGUiLCJ0eXBlIjoicHVia2V5In0seyJuYW1lIjoid29ya2Zsb3dfb3duZXIiLCJkb2NzIjpbIkFsbCB6ZXJvcyBza2lwcyB0aGUgY2hlY2suIl0sInR5cGUiOnsiYXJyYXkiOlsidTgiLDIwXX19LHsibmFtZSI6IndvcmtmbG93X25hbWUiLCJkb2NzIjpbIkFsbCB6ZXJvcyBza2lwcyB0aGUgY2hlY2suIl0sInR5cGUiOnsiYXJyYXkiOlsidTgiLDEwXX19LHsibmFtZSI6ImJ1bXAiLCJ0eXBlIjoidTgifV19fSx7Im5hbWUiOiJXaXRuZXNzUmVjb3JkZWQiLCJkb2NzIjpbIkFsc28gcHV0cyBgV2l0bmVzc1JlcG9ydGAgaW4gdGhlIElETCwgd2hpY2ggYGNyZSBnZW5lcmF0ZS1iaW5kaW5nc2AgbmVlZHMuIl0sInR5cGUiOnsia2luZCI6InN0cnVjdCIsImZpZWxkcyI6W3sibmFtZSI6InJlcG9ydCIsInR5cGUiOnsiZGVmaW5lZCI6eyJuYW1lIjoiV2l0bmVzc1JlcG9ydCJ9fX1dfX0seyJuYW1lIjoiV2l0bmVzc1JlcG9ydCIsImRvY3MiOlsiQm9yc2ggcGF5bG9hZCB0aGUgQ1JFIHdvcmtmbG93IHdyaXRlcyAoMTA2IGJ5dGVzKS4iXSwidHlwZSI6eyJraW5kIjoic3RydWN0IiwiZmllbGRzIjpbeyJuYW1lIjoidmVyIiwidHlwZSI6InU4In0seyJuYW1lIjoiY2hhaW5faWQiLCJ0eXBlIjoidTY0In0seyJuYW1lIjoidHhfaGFzaCIsInR5cGUiOnsiYXJyYXkiOlsidTgiLDMyXX19LHsibmFtZSI6ImZyb20iLCJ0eXBlIjp7ImFycmF5IjpbInU4IiwyMF19fSx7Im5hbWUiOiJ0byIsInR5cGUiOnsiYXJyYXkiOlsidTgiLDIwXX19LHsibmFtZSI6InZhbHVlX3dlaSIsInR5cGUiOiJ1MTI4In0seyJuYW1lIjoiYmxvY2siLCJ0eXBlIjoidTY0In0seyJuYW1lIjoic3RhdHVzIiwiZG9jcyI6WyJFVk0gcmVjZWlwdCBzdGF0dXM6IDEgc3VjY2VzcywgMCByZXZlcnRlZC4iXSwidHlwZSI6InU4In1dfX1dfQ=='

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

export type Claim = {
  requester: Address
  chainId: bigint
  txHash: number[]
  status: number
  from: number[]
  to: number[]
  valueWei: bigint
  block: bigint
  success: boolean
  recordedAt: bigint
  bump: number
}

export const claimCodec = getStructCodec([
  ['requester', getAddressCodec()],
  ['chainId', getU64Codec()],
  ['txHash', getArrayCodec(getU8Codec(), { size: 32 })],
  ['status', getU8Codec()],
  ['from', getArrayCodec(getU8Codec(), { size: 20 })],
  ['to', getArrayCodec(getU8Codec(), { size: 20 })],
  ['valueWei', getU128Codec()],
  ['block', getU64Codec()],
  ['success', getBooleanCodec()],
  ['recordedAt', getI64Codec()],
  ['bump', getU8Codec()],
])

export type ClaimOpened = {
  claim: Address
  requester: Address
  chainId: bigint
  txHash: number[]
}

export const claimOpenedCodec = getStructCodec([
  ['claim', getAddressCodec()],
  ['requester', getAddressCodec()],
  ['chainId', getU64Codec()],
  ['txHash', getArrayCodec(getU8Codec(), { size: 32 })],
])

export type ClaimRecorded = {
  claim: Address
  requester: Address
  success: boolean
}

export const claimRecordedCodec = getStructCodec([
  ['claim', getAddressCodec()],
  ['requester', getAddressCodec()],
  ['success', getBooleanCodec()],
])

export type Config = {
  admin: Address
  forwarderProgram: Address
  forwarderState: Address
  workflowOwner: number[]
  workflowName: number[]
  bump: number
}

export const configCodec = getStructCodec([
  ['admin', getAddressCodec()],
  ['forwarderProgram', getAddressCodec()],
  ['forwarderState', getAddressCodec()],
  ['workflowOwner', getArrayCodec(getU8Codec(), { size: 20 })],
  ['workflowName', getArrayCodec(getU8Codec(), { size: 10 })],
  ['bump', getU8Codec()],
])

export type WitnessReport = {
  ver: number
  chainId: bigint
  txHash: number[]
  from: number[]
  to: number[]
  valueWei: bigint
  block: bigint
  status: number
}

export const witnessReportCodec = getStructCodec([
  ['ver', getU8Codec()],
  ['chainId', getU64Codec()],
  ['txHash', getArrayCodec(getU8Codec(), { size: 32 })],
  ['from', getArrayCodec(getU8Codec(), { size: 20 })],
  ['to', getArrayCodec(getU8Codec(), { size: 20 })],
  ['valueWei', getU128Codec()],
  ['block', getU64Codec()],
  ['status', getU8Codec()],
])

export type WitnessRecorded = {
  report: WitnessReport
}

export const witnessRecordedCodec = getStructCodec([
  ['report', witnessReportCodec],
])

export const ACCOUNT_CLAIM_DISCRIMINATOR = new Uint8Array([155, 70, 22, 176, 123, 215, 246, 102])

/**
 * Decodes raw Claim account data (with its 8-byte discriminator) into Claim.
 * Pure helper — there is no read capability; obtain the account bytes elsewhere.
 */
export const decodeClaimAccount = (data: Uint8Array): Claim =>
  claimCodec.decode(expectDiscriminator('account Claim', ACCOUNT_CLAIM_DISCRIMINATOR, data)) as Claim

export const ACCOUNT_CONFIG_DISCRIMINATOR = new Uint8Array([155, 12, 170, 224, 30, 250, 204, 130])

/**
 * Decodes raw Config account data (with its 8-byte discriminator) into Config.
 * Pure helper — there is no read capability; obtain the account bytes elsewhere.
 */
export const decodeConfigAccount = (data: Uint8Array): Config =>
  configCodec.decode(expectDiscriminator('account Config', ACCOUNT_CONFIG_DISCRIMINATOR, data)) as Config

export const EVENT_CLAIM_OPENED_DISCRIMINATOR = new Uint8Array([149, 209, 22, 4, 147, 156, 128, 152])

/**
 * Decodes raw ClaimOpened event data (with its 8-byte discriminator) into ClaimOpened.
 */
export const decodeClaimOpenedEvent = (data: Uint8Array): ClaimOpened =>
  claimOpenedCodec.decode(expectDiscriminator('event ClaimOpened', EVENT_CLAIM_OPENED_DISCRIMINATOR, data)) as ClaimOpened

export const EVENT_CLAIM_RECORDED_DISCRIMINATOR = new Uint8Array([46, 183, 32, 80, 59, 171, 138, 224])

/**
 * Decodes raw ClaimRecorded event data (with its 8-byte discriminator) into ClaimRecorded.
 */
export const decodeClaimRecordedEvent = (data: Uint8Array): ClaimRecorded =>
  claimRecordedCodec.decode(expectDiscriminator('event ClaimRecorded', EVENT_CLAIM_RECORDED_DISCRIMINATOR, data)) as ClaimRecorded

export const EVENT_WITNESS_RECORDED_DISCRIMINATOR = new Uint8Array([167, 46, 15, 114, 190, 74, 3, 156])

/**
 * Decodes raw WitnessRecorded event data (with its 8-byte discriminator) into WitnessRecorded.
 */
export const decodeWitnessRecordedEvent = (data: Uint8Array): WitnessRecorded =>
  witnessRecordedCodec.decode(expectDiscriminator('event WitnessRecorded', EVENT_WITNESS_RECORDED_DISCRIMINATOR, data)) as WitnessRecorded

export const parseAnyAccount = (data: Uint8Array): Claim | Config => {
  const disc = data.subarray(0, DISCRIMINATOR_SIZE)
  const matches = (expected: Uint8Array) => expected.every((b, i) => disc[i] === b)
  if (matches(ACCOUNT_CLAIM_DISCRIMINATOR)) return decodeClaimAccount(data)
  if (matches(ACCOUNT_CONFIG_DISCRIMINATOR)) return decodeConfigAccount(data)
  throw new Error(`unknown account discriminator: [${Array.from(disc).join(', ')}]`)
}

export const parseAnyEvent = (data: Uint8Array): ClaimOpened | ClaimRecorded | WitnessRecorded => {
  const disc = data.subarray(0, DISCRIMINATOR_SIZE)
  const matches = (expected: Uint8Array) => expected.every((b, i) => disc[i] === b)
  if (matches(EVENT_CLAIM_OPENED_DISCRIMINATOR)) return decodeClaimOpenedEvent(data)
  if (matches(EVENT_CLAIM_RECORDED_DISCRIMINATOR)) return decodeClaimRecordedEvent(data)
  if (matches(EVENT_WITNESS_RECORDED_DISCRIMINATOR)) return decodeWitnessRecordedEvent(data)
  throw new Error(`unknown event discriminator: [${Array.from(disc).join(', ')}]`)
}

/**
 * Optional filter values for ClaimOpened log triggers. Set fields in one row to
 * AND those predicates. Multiple rows are OR alternatives, but current trigger
 * configuration supports only a single row. Leave unset for wildcard. Only top-level
 * scalar fields with supported subkey encodings are auto-filterable — nested
 * structs, vecs, arrays, bool, u128, and i128 need a manual SubkeyConfig.
 */
export type ClaimOpenedFilters = {
  claim?: Address | null
  requester?: Address | null
  chainId?: bigint | null
}

export const encodeClaimOpenedSubkeys = (filters: ClaimOpenedFilters[]): SolanaSubkeyConfigJson[] => {
  if (filters.length > 1) {
    throw new Error('multiple filter rows are not supported for ClaimOpened; provide a single filter row')
  }
  const claimComparers: SolanaValueComparatorJson[] = []
  const requesterComparers: SolanaValueComparatorJson[] = []
  const chainIdComparers: SolanaValueComparatorJson[] = []
  for (const f of filters) {
    if (f.claim != null) {
      claimComparers.push({
        operator: 'COMPARISON_OPERATOR_EQ',
        value: bytesToBase64(solanaAddressToBytes(f.claim)),
      })
    }
    if (f.requester != null) {
      requesterComparers.push({
        operator: 'COMPARISON_OPERATOR_EQ',
        value: bytesToBase64(solanaAddressToBytes(f.requester)),
      })
    }
    if (f.chainId != null) {
      chainIdComparers.push({
        operator: 'COMPARISON_OPERATOR_EQ',
        value: bytesToBase64(prepareSubkeyValue(f.chainId)),
      })
    }
  }
  const subkeys: SolanaSubkeyConfigJson[] = []
  if (claimComparers.length > 0) {
    subkeys.push({ path: ['Claim'], comparers: claimComparers })
  }
  if (requesterComparers.length > 0) {
    subkeys.push({ path: ['Requester'], comparers: requesterComparers })
  }
  if (chainIdComparers.length > 0) {
    subkeys.push({ path: ['ChainId'], comparers: chainIdComparers })
  }
  return subkeys
}

/**
 * Optional filter values for ClaimRecorded log triggers. Set fields in one row to
 * AND those predicates. Multiple rows are OR alternatives, but current trigger
 * configuration supports only a single row. Leave unset for wildcard. Only top-level
 * scalar fields with supported subkey encodings are auto-filterable — nested
 * structs, vecs, arrays, bool, u128, and i128 need a manual SubkeyConfig.
 */
export type ClaimRecordedFilters = {
  claim?: Address | null
  requester?: Address | null
}

export const encodeClaimRecordedSubkeys = (filters: ClaimRecordedFilters[]): SolanaSubkeyConfigJson[] => {
  if (filters.length > 1) {
    throw new Error('multiple filter rows are not supported for ClaimRecorded; provide a single filter row')
  }
  const claimComparers: SolanaValueComparatorJson[] = []
  const requesterComparers: SolanaValueComparatorJson[] = []
  for (const f of filters) {
    if (f.claim != null) {
      claimComparers.push({
        operator: 'COMPARISON_OPERATOR_EQ',
        value: bytesToBase64(solanaAddressToBytes(f.claim)),
      })
    }
    if (f.requester != null) {
      requesterComparers.push({
        operator: 'COMPARISON_OPERATOR_EQ',
        value: bytesToBase64(solanaAddressToBytes(f.requester)),
      })
    }
  }
  const subkeys: SolanaSubkeyConfigJson[] = []
  if (claimComparers.length > 0) {
    subkeys.push({ path: ['Claim'], comparers: claimComparers })
  }
  if (requesterComparers.length > 0) {
    subkeys.push({ path: ['Requester'], comparers: requesterComparers })
  }
  return subkeys
}

/**
 * Optional filter values for WitnessRecorded log triggers. Set fields in one row to
 * AND those predicates. Multiple rows are OR alternatives, but current trigger
 * configuration supports only a single row. Leave unset for wildcard. Only top-level
 * scalar fields with supported subkey encodings are auto-filterable — nested
 * structs, vecs, arrays, bool, u128, and i128 need a manual SubkeyConfig.
 */
export type WitnessRecordedFilters = Record<string, never>

export const encodeWitnessRecordedSubkeys = (filters: WitnessRecordedFilters[]): SolanaSubkeyConfigJson[] => {
  if (filters.length > 1) {
    throw new Error('multiple filter rows are not supported for WitnessRecorded; provide a single filter row')
  }
  return []
}

export class SodaWitness {
  readonly programId: Uint8Array

  // The program ID is baked into the IDL, so it defaults to the generated
  // const — unlike EVM bindings where the address is a runtime value.
  constructor(
    private readonly client: SolanaClient,
    programId: string | Uint8Array = SODA_WITNESS_PROGRAM_ID,
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

  writeReportFromClaim(
    runtime: Runtime<unknown>,
    input: Claim,
    remainingAccounts: SolanaAccountMeta[],
    computeConfig?: SolanaComputeConfig,
  ) {
    return this.writeReport(runtime, new Uint8Array(claimCodec.encode(input)), remainingAccounts, computeConfig)
  }

  writeReportFromClaims(
    runtime: Runtime<unknown>,
    inputs: Claim[],
    remainingAccounts: SolanaAccountMeta[],
    computeConfig?: SolanaComputeConfig,
  ) {
    return this.writeReportFromBorshEncodedVec(
      runtime,
      inputs.map((input) => new Uint8Array(claimCodec.encode(input))),
      remainingAccounts,
      computeConfig,
    )
  }

  writeReportFromClaimOpened(
    runtime: Runtime<unknown>,
    input: ClaimOpened,
    remainingAccounts: SolanaAccountMeta[],
    computeConfig?: SolanaComputeConfig,
  ) {
    return this.writeReport(runtime, new Uint8Array(claimOpenedCodec.encode(input)), remainingAccounts, computeConfig)
  }

  writeReportFromClaimOpeneds(
    runtime: Runtime<unknown>,
    inputs: ClaimOpened[],
    remainingAccounts: SolanaAccountMeta[],
    computeConfig?: SolanaComputeConfig,
  ) {
    return this.writeReportFromBorshEncodedVec(
      runtime,
      inputs.map((input) => new Uint8Array(claimOpenedCodec.encode(input))),
      remainingAccounts,
      computeConfig,
    )
  }

  writeReportFromClaimRecorded(
    runtime: Runtime<unknown>,
    input: ClaimRecorded,
    remainingAccounts: SolanaAccountMeta[],
    computeConfig?: SolanaComputeConfig,
  ) {
    return this.writeReport(runtime, new Uint8Array(claimRecordedCodec.encode(input)), remainingAccounts, computeConfig)
  }

  writeReportFromClaimRecordeds(
    runtime: Runtime<unknown>,
    inputs: ClaimRecorded[],
    remainingAccounts: SolanaAccountMeta[],
    computeConfig?: SolanaComputeConfig,
  ) {
    return this.writeReportFromBorshEncodedVec(
      runtime,
      inputs.map((input) => new Uint8Array(claimRecordedCodec.encode(input))),
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

  writeReportFromWitnessReport(
    runtime: Runtime<unknown>,
    input: WitnessReport,
    remainingAccounts: SolanaAccountMeta[],
    computeConfig?: SolanaComputeConfig,
  ) {
    return this.writeReport(runtime, new Uint8Array(witnessReportCodec.encode(input)), remainingAccounts, computeConfig)
  }

  writeReportFromWitnessReports(
    runtime: Runtime<unknown>,
    inputs: WitnessReport[],
    remainingAccounts: SolanaAccountMeta[],
    computeConfig?: SolanaComputeConfig,
  ) {
    return this.writeReportFromBorshEncodedVec(
      runtime,
      inputs.map((input) => new Uint8Array(witnessReportCodec.encode(input))),
      remainingAccounts,
      computeConfig,
    )
  }

  writeReportFromWitnessRecorded(
    runtime: Runtime<unknown>,
    input: WitnessRecorded,
    remainingAccounts: SolanaAccountMeta[],
    computeConfig?: SolanaComputeConfig,
  ) {
    return this.writeReport(runtime, new Uint8Array(witnessRecordedCodec.encode(input)), remainingAccounts, computeConfig)
  }

  writeReportFromWitnessRecordeds(
    runtime: Runtime<unknown>,
    inputs: WitnessRecorded[],
    remainingAccounts: SolanaAccountMeta[],
    computeConfig?: SolanaComputeConfig,
  ) {
    return this.writeReportFromBorshEncodedVec(
      runtime,
      inputs.map((input) => new Uint8Array(witnessRecordedCodec.encode(input))),
      remainingAccounts,
      computeConfig,
    )
  }

  /**
   * Registers a typed log trigger for ClaimOpened events. The trigger
   * output is adapted to the decoded ClaimOpened data alongside the raw log.
   * Pass opts.cpi for events emitted via Anchor's emit_cpi!.
   */
  logTriggerClaimOpenedLog(
    filterName: string,
    filters: ClaimOpenedFilters[] = [],
    opts?: SolanaLogTriggerOptions,
  ): Trigger<SolanaLog, SolanaDecodedLog<ClaimOpened>> {
    const config: SolanaFilterLogTriggerRequestJson = {
      name: filterName,
      address: bytesToBase64(this.programId),
      eventName: 'ClaimOpened',
      contractIdlJson: SODA_WITNESS_IDL_BASE64,
      subkeys: encodeClaimOpenedSubkeys(filters),
    }
    if (opts?.cpi) {
      config.cpiFilterConfig = anchorCPILogTriggerConfig(this.programId)
    }
    return adaptTrigger(this.client.logTrigger(config), (log) => ({
      log,
      data: decodeClaimOpenedEvent(log.data),
    }))
  }

  /**
   * Registers a typed log trigger for ClaimRecorded events. The trigger
   * output is adapted to the decoded ClaimRecorded data alongside the raw log.
   * Pass opts.cpi for events emitted via Anchor's emit_cpi!.
   */
  logTriggerClaimRecordedLog(
    filterName: string,
    filters: ClaimRecordedFilters[] = [],
    opts?: SolanaLogTriggerOptions,
  ): Trigger<SolanaLog, SolanaDecodedLog<ClaimRecorded>> {
    const config: SolanaFilterLogTriggerRequestJson = {
      name: filterName,
      address: bytesToBase64(this.programId),
      eventName: 'ClaimRecorded',
      contractIdlJson: SODA_WITNESS_IDL_BASE64,
      subkeys: encodeClaimRecordedSubkeys(filters),
    }
    if (opts?.cpi) {
      config.cpiFilterConfig = anchorCPILogTriggerConfig(this.programId)
    }
    return adaptTrigger(this.client.logTrigger(config), (log) => ({
      log,
      data: decodeClaimRecordedEvent(log.data),
    }))
  }

  /**
   * Registers a typed log trigger for WitnessRecorded events. The trigger
   * output is adapted to the decoded WitnessRecorded data alongside the raw log.
   * Pass opts.cpi for events emitted via Anchor's emit_cpi!.
   */
  logTriggerWitnessRecordedLog(
    filterName: string,
    filters: WitnessRecordedFilters[] = [],
    opts?: SolanaLogTriggerOptions,
  ): Trigger<SolanaLog, SolanaDecodedLog<WitnessRecorded>> {
    const config: SolanaFilterLogTriggerRequestJson = {
      name: filterName,
      address: bytesToBase64(this.programId),
      eventName: 'WitnessRecorded',
      contractIdlJson: SODA_WITNESS_IDL_BASE64,
      subkeys: encodeWitnessRecordedSubkeys(filters),
    }
    if (opts?.cpi) {
      config.cpiFilterConfig = anchorCPILogTriggerConfig(this.programId)
    }
    return adaptTrigger(this.client.logTrigger(config), (log) => ({
      log,
      data: decodeWitnessRecordedEvent(log.data),
    }))
  }
}
