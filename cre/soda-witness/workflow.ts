// SODA Witness: reads a Base Sepolia transaction over JSON-RPC, agrees on it
// across the DON, and writes the facts into soda_witness::on_report on Solana.
// Structure follows smartcontractkit/cre-templates solana-read-write-ts (MIT).
import {
	bytesToBase64,
	consensusIdenticalAggregation,
	consensusMedianAggregation,
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
import { SodaWitness, type WitnessReport } from './contracts/solana/ts/generated'

const BASE58 = getBase58Decoder()
const FORWARDER_SEED = new TextEncoder().encode('forwarder')
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`
const REPORT_VERSION = 1

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
	witnessConfig: base58Address,
	chainId: z.number().int().positive(),
	minConfirmations: z.number().int().nonnegative(),
	// Deployed workflows need a trigger key; simulation accepts trigger({}).
	authorizedEvmKey: z
		.string()
		.regex(/^0x[0-9a-fA-F]{40}$/)
		.optional(),
})

export type Config = z.infer<typeof configSchema>

export const payloadSchema = z.object({
	claim: base58Address,
	txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
})

// Strings only, so every node's answer compares byte for byte.
type ReceiptFacts = { status: string; blockNumber: string; from: string; to: string }
type TxFacts = { value: string; chainId: string }

const rpc = (
	sendRequester: HTTPSendRequester,
	url: string,
	method: string,
	params: unknown[],
): unknown => {
	const body = new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))
	const resp = sendRequester
		.sendRequest({
			url,
			method: 'POST',
			body: bytesToBase64(body),
			multiHeaders: {
				'content-type': { values: ['application/json'] },
			},
			timeout: '8s',
			cacheSettings: { store: true, maxAge: '60s' },
		})
		.result()
	if (!ok(resp)) {
		throw new Error(`${method}: HTTP ${resp.statusCode} ${text(resp).slice(0, 120)}`)
	}
	const parsed = json(resp) as { result?: unknown; error?: { message?: string } }
	if (parsed.error) {
		throw new Error(`${method}: ${parsed.error.message ?? 'RPC error'}`)
	}
	if (parsed.result === null || parsed.result === undefined) {
		throw new Error(`${method}: not found (pending or unknown transaction)`)
	}
	return parsed.result
}

export const fetchReceipt = (
	sendRequester: HTTPSendRequester,
	url: string,
	txHash: string,
): ReceiptFacts => {
	const r = rpc(sendRequester, url, 'eth_getTransactionReceipt', [txHash]) as Record<string, string | null>
	return {
		status: String(r.status).toLowerCase(),
		blockNumber: String(r.blockNumber).toLowerCase(),
		from: String(r.from).toLowerCase(),
		// Contract creations have no `to`.
		to: (r.to ?? ZERO_ADDRESS).toLowerCase(),
	}
}

export const fetchTx = (sendRequester: HTTPSendRequester, url: string, txHash: string): TxFacts => {
	const t = rpc(sendRequester, url, 'eth_getTransactionByHash', [txHash]) as Record<string, string | null>
	return {
		value: String(t.value).toLowerCase(),
		// Pre-EIP-155 legacy transactions carry no chainId.
		chainId: (t.chainId ?? '').toLowerCase(),
	}
}

export const fetchHead = (sendRequester: HTTPSendRequester, url: string): bigint =>
	BigInt(rpc(sendRequester, url, 'eth_blockNumber', []) as string)

const addressBytes = (hex: string): number[] => {
	const bytes = hexToBytes(hex)
	if (bytes.length !== 20) throw new Error(`Bad EVM address: ${hex}`)
	return Array.from(bytes)
}

// web3.js's sync PDA helper, because @solana/addresses hashes via crypto.subtle,
// which the WASM runtime does not have.
export const forwarderAuthority = (cfg: Config): PublicKey =>
	PublicKey.findProgramAddressSync(
		[
			FORWARDER_SEED,
			new PublicKey(cfg.forwarderState).toBytes(),
			new PublicKey(cfg.receiverProgramId).toBytes(),
		],
		new PublicKey(cfg.forwarderProgramId),
	)[0]

export const onWitnessRequest = (runtime: Runtime<Config>, payload: HTTPPayload) => {
	const cfg = runtime.config
	const { claim, txHash: rawHash } = payloadSchema.parse(decodeJson(payload.input))
	const txHash = rawHash.toLowerCase()
	runtime.log(`Witness request: claim=${claim} tx=${txHash}`)

	// A secret, because a keyed provider URL carries its key in the path.
	const baseRpcUrl = runtime.getSecret({ id: 'BASE_RPC_URL' }).result().value
	if (!/^https:\/\/\S+$/.test(baseRpcUrl)) throw new Error('BASE_RPC_URL secret must be an https URL')
	const http = new HTTPClient()

	const receipt = http
		.sendRequest(runtime, fetchReceipt, consensusIdenticalAggregation<ReceiptFacts>())(baseRpcUrl, txHash)
		.result()
	const tx = http
		.sendRequest(runtime, fetchTx, consensusIdenticalAggregation<TxFacts>())(baseRpcUrl, txHash)
		.result()
	const head = http
		.sendRequest(runtime, fetchHead, consensusMedianAggregation<bigint>())(baseRpcUrl)
		.result()

	if (tx.chainId !== '' && BigInt(tx.chainId) !== BigInt(cfg.chainId)) {
		throw new Error(`Transaction is on chain ${BigInt(tx.chainId)}, expected ${cfg.chainId}`)
	}

	// Computed after consensus: head moves, so it never goes through identical aggregation.
	const block = BigInt(receipt.blockNumber)
	const confirmations = head - block
	if (confirmations < BigInt(cfg.minConfirmations)) {
		throw new Error(`Only ${confirmations} confirmations (head ${head}, block ${block}); need ${cfg.minConfirmations}`)
	}

	const report: WitnessReport = {
		ver: REPORT_VERSION,
		chainId: BigInt(cfg.chainId),
		txHash: Array.from(hexToBytes(txHash)),
		from: addressBytes(receipt.from),
		to: addressBytes(receipt.to),
		valueWei: BigInt(tx.value),
		block,
		status: BigInt(receipt.status) === 1n ? 1 : 0,
	}
	runtime.log(
		`Facts: from=${receipt.from} to=${receipt.to} value=${report.valueWei} block=${block} ` +
			`status=${report.status} confirmations=${confirmations}`,
	)

	// Forwarder layout: state, authority, then on_report's own accounts (config, claim).
	// The forwarder hashes these keys in order and checks the hash against the report.
	const remainingAccounts: SolanaAccountMeta[] = [
		solanaAccountMeta(cfg.forwarderState),
		solanaAccountMeta(forwarderAuthority(cfg).toBase58()),
		solanaAccountMeta(cfg.witnessConfig),
		solanaAccountMeta(claim, true),
	]

	const witness = new SodaWitness(new SolanaClient(BigInt(cfg.chainSelector)), cfg.receiverProgramId)
	const resp = witness.writeReportFromWitnessReport(runtime, report, remainingAccounts, { computeLimit: 200_000 })

	if (resp.txStatus !== SolanaTxStatus.SUCCESS) {
		throw new Error(`on_report write failed: ${resp.errorMessage || SolanaTxStatus[resp.txStatus]}`)
	}
	const signature = resp.txSignature ? BASE58.decode(resp.txSignature) : ''
	runtime.log(`Recorded claim ${claim}: tx=${signature} explorer=https://explorer.solana.com/tx/${signature}?cluster=devnet`)

	return {
		Claim: claim,
		TxHash: txHash,
		Success: report.status === 1,
		Block: block.toString(),
		Confirmations: confirmations.toString(),
		Signature: signature,
	}
}

export const initWorkflow = (config: Config) => {
	const http = new HTTPCapability()
	const trigger = config.authorizedEvmKey
		? http.trigger({ authorizedKeys: [{ type: 'KEY_TYPE_ECDSA_EVM', publicKey: config.authorizedEvmKey }] })
		: http.trigger({})
	return [handler(trigger, onWitnessRequest)]
}
