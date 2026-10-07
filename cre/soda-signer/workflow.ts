// SODA Signer: given a pending soda SigRequest, asks the MPC coordinator for the
// secp256k1 signature, agrees on it across the DON, and writes it into
// soda_cre_signer::on_report, which CPIs soda finalize_signature.
// Structure follows smartcontractkit/cre-templates solana-read-write-ts (MIT).
import {
	bytesToBase64,
	bytesToHex,
	consensusIdenticalAggregation,
	decodeJson,
	handler,
	hexToBytes,
	HTTPCapability,
	HTTPClient,
	type HTTPPayload,
	type HTTPSendRequester,
	json,
	ok,
	type Runtime,
	type SolanaAccountMeta,
	SolanaClient,
	SolanaTxStatus,
	solanaAccountMeta,
	text,
} from '@chainlink/cre-sdk'
import { getBase58Decoder } from '@solana/codecs'
import { PublicKey } from '@solana/web3.js'
import { z } from 'zod'
import { SodaCreSigner, type SignerReport } from './contracts/solana/ts/generated'

const BASE58 = getBase58Decoder()
const REPORT_VERSION = 1
export const SODA_PROGRAM_ID = 'CPAEfBXpMMsUrjLNhDYxaCH79DYvFHJFC27fttnxAL1J'
export const SODA_COMMITTEE = '9mX3oHUmsrYvzXjCo35HhfXufrGZT3hjsLoC74xbA6SS'
const SIG_REQUEST_DISCRIMINATOR = '3617d2807be9f1e9'

const base58Address = z.string().refine(
	(value) => {
		try {
			new PublicKey(value)
			return true
		} catch {
			return false
		}
	},
	{ message: 'Invalid base58 Solana address' },
)

export const configSchema = z.object({
	chainSelector: z.string(),
	receiverProgramId: base58Address,
	forwarderProgramId: base58Address,
	forwarderState: base58Address,
	signerConfig: base58Address,
	coordinatorUrl: z.string().regex(/^https:\/\/\S+$/),
	// Deployed workflows need a trigger key; simulation accepts trigger({}).
	authorizedEvmKey: z
		.string()
		.regex(/^0x[0-9a-fA-F]{40}$/)
		.optional(),
})

export type Config = z.infer<typeof configSchema>

export const payloadSchema = z.object({ sigRequest: base58Address })

type SigRequestFacts = { owner: string; completed: boolean }
type Signature = { r: string; s: string; v: number }

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// The WASM runtime has no atob or Buffer, and the SDK exports only the encoder.
export const base64ToBytes = (b64: string): Uint8Array => {
	const clean = b64.replace(/=+$/, '')
	const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
	let bits = 0
	let acc = 0
	let i = 0
	for (const ch of clean) {
		const v = B64.indexOf(ch)
		if (v < 0) throw new Error('Invalid base64')
		acc = (acc << 6) | v
		bits += 6
		if (bits >= 8) {
			bits -= 8
			out[i++] = (acc >> bits) & 0xff
		}
	}
	return out
}

/** Byte offset of `completed` in a SigRequest (HANDOVER §1.4), past the variable seeds. */
export const completedFlag = (data: Uint8Array): boolean => {
	if (data.length < 8 || bytesToHex(data.subarray(0, 8)).replace(/^0x/, '') !== SIG_REQUEST_DISCRIMINATOR) {
		throw new Error('Account is not a soda SigRequest')
	}
	// disc 8 | bump 1 | requester 32 | committee 32 | foreign_pk_xy 64 | seeds len u32
	const seedsLenAt = 8 + 1 + 32 + 32 + 64
	if (data.length < seedsLenAt + 4) throw new Error('SigRequest data too short')
	const seedsLen = new DataView(data.buffer, data.byteOffset + seedsLenAt, 4).getUint32(0, true)
	// seeds | payload 32 | chain_tag 32 | domain_id 4 | expires_at 8 | completed
	const at = seedsLenAt + 4 + seedsLen + 32 + 32 + 4 + 8
	if (at >= data.length) throw new Error('SigRequest data too short')
	return data[at] !== 0
}

export const fetchSigRequest = (
	sendRequester: HTTPSendRequester,
	url: string,
	sigRequest: string,
): SigRequestFacts => {
	const body = JSON.stringify({
		jsonrpc: '2.0',
		id: 1,
		method: 'getAccountInfo',
		params: [sigRequest, { encoding: 'base64', commitment: 'confirmed' }],
	})
	const resp = sendRequester
		.sendRequest({
			url,
			method: 'POST',
			body: bytesToBase64(new TextEncoder().encode(body)),
			multiHeaders: { 'content-type': { values: ['application/json'] } },
			timeout: '8s',
		})
		.result()
	if (!ok(resp)) throw new Error(`getAccountInfo: HTTP ${resp.statusCode} ${text(resp).slice(0, 120)}`)
	const parsed = json(resp) as {
		result?: { value: { owner: string; data: [string, string] } | null }
		error?: { message?: string }
	}
	if (parsed.error) throw new Error(`getAccountInfo: ${parsed.error.message ?? 'RPC error'}`)
	const value = parsed.result?.value
	if (!value) throw new Error(`SigRequest ${sigRequest} not found`)
	return { owner: value.owner, completed: completedFlag(base64ToBytes(value.data[0])) }
}

export const fetchSignature = (
	sendRequester: HTTPSendRequester,
	coordinatorUrl: string,
	token: string,
	sigRequest: string,
): Signature => {
	const body = JSON.stringify({ sigRequestPubkey: sigRequest })
	const resp = sendRequester
		.sendRequest({
			url: `${coordinatorUrl.replace(/\/$/, '')}/sign`,
			method: 'POST',
			body: bytesToBase64(new TextEncoder().encode(body)),
			multiHeaders: {
				'content-type': { values: ['application/json'] },
				authorization: { values: [`Bearer ${token}`] },
			},
			timeout: '30s',
			cacheSettings: { store: true, maxAge: '60s' },
		})
		.result()
	if (!ok(resp)) throw new Error(`coordinator /sign: HTTP ${resp.statusCode} ${text(resp).slice(0, 120)}`)
	const sig = json(resp) as { r?: unknown; s?: unknown; v?: unknown }
	if (typeof sig.r !== 'string' || typeof sig.s !== 'string' || typeof sig.v !== 'number') {
		throw new Error('coordinator /sign: malformed response')
	}
	const norm = (h: string) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0')
	return { r: norm(sig.r), s: norm(sig.s), v: sig.v }
}

// web3.js's sync PDA helper, because @solana/addresses hashes via crypto.subtle,
// which the WASM runtime does not have.
export const forwarderAuthority = (cfg: Config): PublicKey =>
	PublicKey.findProgramAddressSync(
		[
			new TextEncoder().encode('forwarder'),
			new PublicKey(cfg.forwarderState).toBytes(),
			new PublicKey(cfg.receiverProgramId).toBytes(),
		],
		new PublicKey(cfg.forwarderProgramId),
	)[0]

export const submitterPda = (cfg: Config): PublicKey =>
	PublicKey.findProgramAddressSync([new TextEncoder().encode('submitter')], new PublicKey(cfg.receiverProgramId))[0]

export const onSignRequest = (runtime: Runtime<Config>, payload: HTTPPayload) => {
	const cfg = runtime.config
	const { sigRequest } = payloadSchema.parse(decodeJson(payload.input))
	runtime.log(`Sign request: sigRequest=${sigRequest}`)

	const rpcUrl = runtime.getSecret({ id: 'SOLANA_RPC_URL' }).result().value
	if (!/^https:\/\/\S+$/.test(rpcUrl)) throw new Error('SOLANA_RPC_URL secret must be an https URL')
	const token = runtime.getSecret({ id: 'MPC_COORDINATOR_TOKEN' }).result().value
	const http = new HTTPClient()

	// (1) The SigRequest must be a live, uncompleted soda account.
	const facts = http
		.sendRequest(runtime, fetchSigRequest, consensusIdenticalAggregation<SigRequestFacts>())(rpcUrl, sigRequest)
		.result()
	if (facts.owner !== SODA_PROGRAM_ID) throw new Error(`SigRequest owner is ${facts.owner}, not soda`)
	if (facts.completed) throw new Error(`SigRequest ${sigRequest} is already completed`)

	// (2) The MPC committee signs it.
	const sig = http
		.sendRequest(runtime, fetchSignature, consensusIdenticalAggregation<Signature>())(
			cfg.coordinatorUrl,
			token,
			sigRequest,
		)
		.result()
	const recoveryId = sig.v >= 27 ? sig.v - 27 : sig.v
	if (recoveryId !== 0 && recoveryId !== 1) throw new Error(`Bad recovery id v=${sig.v}`)
	const signature = Array.from(hexToBytes(`0x${sig.r}${sig.s}`))
	if (signature.length !== 64) throw new Error('Signature must be 64 bytes')

	// (3) Write it. soda re-verifies the signature on chain against the request's key.
	const report: SignerReport = {
		ver: REPORT_VERSION,
		sigRequest: sigRequest as SignerReport['sigRequest'],
		signature,
		recoveryId,
	}
	runtime.log(`Signature: r=${sig.r} s=${sig.s} recovery_id=${recoveryId}`)

	// Forwarder layout: state, authority, then on_report's own accounts.
	const remainingAccounts: SolanaAccountMeta[] = [
		solanaAccountMeta(cfg.forwarderState),
		solanaAccountMeta(forwarderAuthority(cfg).toBase58()),
		solanaAccountMeta(cfg.signerConfig),
		solanaAccountMeta(sigRequest, true),
		solanaAccountMeta(SODA_COMMITTEE),
		solanaAccountMeta(submitterPda(cfg).toBase58()),
		solanaAccountMeta(SODA_PROGRAM_ID),
	]

	const signer = new SodaCreSigner(new SolanaClient(BigInt(cfg.chainSelector)), cfg.receiverProgramId)
	const resp = signer.writeReportFromSignerReport(runtime, report, remainingAccounts, { computeLimit: 200_000 })
	if (resp.txStatus !== SolanaTxStatus.SUCCESS) {
		throw new Error(`on_report write failed: ${resp.errorMessage || SolanaTxStatus[resp.txStatus]}`)
	}
	const txSig = resp.txSignature ? BASE58.decode(resp.txSignature) : ''
	runtime.log(`Finalized ${sigRequest}: tx=${txSig} explorer=https://explorer.solana.com/tx/${txSig}?cluster=devnet`)

	return { SigRequest: sigRequest, RecoveryId: recoveryId, Signature: txSig }
}

export const initWorkflow = (config: Config) => {
	const http = new HTTPCapability()
	const trigger = config.authorizedEvmKey
		? http.trigger({ authorizedKeys: [{ type: 'KEY_TYPE_ECDSA_EVM', publicKey: config.authorizedEvmKey }] })
		: http.trigger({})
	return [handler(trigger, onSignRequest)]
}
