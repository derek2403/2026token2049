// Runs the handler against the SDK's test runtime: NOWNodes and the Solana write
// are mocked, consensus is the SDK default. `bun test` from cre/soda-witness.
import { describe, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { bytesToBase64, SolanaTxStatus } from '@chainlink/cre-sdk'
import {
	HttpActionsMock,
	newTestRuntime,
	REPORT_METADATA_HEADER_LENGTH,
	SolanaMock,
	type SolanaWriteReportMockInput,
	test,
} from '@chainlink/cre-sdk/test'
import { PublicKey } from '@solana/web3.js'
import { newSodaWitnessMock } from './contracts/solana/ts/generated/SodaWitness_mock'
import { witnessReportCodec } from './contracts/solana/ts/generated'
import simulationConfig from './config.simulation.json'
import { type Config, configSchema, onWitnessRequest } from './workflow'

const CONFIG: Config = configSchema.parse(simulationConfig)
const SOLANA_DEVNET = 16423721717087811551n
const CLAIM = 'GkVu1AXhnFaUhcgW4sZXzDstHwPZ7CmfHkmrSXqHPKTx'
// Mock forwarder authority for this receiver, from the program tests.
const FORWARDER_AUTHORITY = '9P28s29zwBUyXjcbhb8t9QDkvf2i1UC5wrviSvewoNkX'

// Real Base Sepolia transaction: BOT 0x3177… funds the pool address with 1 ETH.
const TX = '0xb9d12a5ab63a10f508a1288e0fa6db38da7a46b50d25daf06125669aec2757d7'
const RECEIPT = {
	status: '0x1',
	blockNumber: '0x2d95d9e',
	from: '0x31777694f7b90b635b1f3b786f5d24be7651be7b',
	to: '0x7662920f66682d8996ec6b6d9e4ac9ed25a1006c',
}
const TXN = { value: '0xde0b6b3a7640000', chainId: '0x14a34' }

type Chain = { receipt?: Record<string, unknown> | null; tx?: Record<string, unknown>; head?: string }

const setup = (chain: Chain = {}, txStatus: 'TX_STATUS_SUCCESS' | 'TX_STATUS_FATAL' = 'TX_STATUS_SUCCESS') => {
	const requests: { method: string; req: any }[] = []
	const http = HttpActionsMock.testInstance()
	http.sendRequest = (req) => {
		const { method } = JSON.parse(new TextDecoder().decode(req.body))
		requests.push({ method, req })
		const result =
			method === 'eth_getTransactionReceipt'
				? ('receipt' in chain ? chain.receipt : RECEIPT)
				: method === 'eth_getTransactionByHash'
					? (chain.tx ?? TXN)
					: (chain.head ?? '0x2d95da8')
		const body = new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
		return { statusCode: 200, body: bytesToBase64(body) }
	}

	const writes: SolanaWriteReportMockInput[] = []
	const witness = newSodaWitnessMock(SolanaMock.testInstance(SOLANA_DEVNET), CONFIG.receiverProgramId)
	witness.writeReport = (input) => {
		writes.push(input)
		return { txStatus, txSignature: bytesToBase64(new Uint8Array(64).fill(7)), errorMessage: 'boom' }
	}

	const secrets = new Map([['main', new Map([['BASE_RPC_URL', 'https://base-sepolia.example/rpc/test-key']])]])
	const runtime = newTestRuntime<Config>(secrets, {}, CONFIG)
	const payload = (body: unknown) => ({ input: new TextEncoder().encode(JSON.stringify(body)) }) as any
	return { runtime, requests, writes, payload }
}

// rawReport = metadata (109) | accountHash (32) | u32 len | payload
const splitReport = (write: SolanaWriteReportMockInput) => {
	const raw = write.report.rawReport.subarray(REPORT_METADATA_HEADER_LENGTH)
	const len = new DataView(raw.buffer, raw.byteOffset + 32, 4).getUint32(0, true)
	return { accountHash: raw.subarray(0, 32), payload: raw.subarray(36, 36 + len) }
}

describe('onWitnessRequest', () => {
	test('reads NOWNodes, agrees, and writes a 106-byte WitnessReport', () => {
		const { runtime, requests, writes, payload } = setup()
		const out = onWitnessRequest(runtime, payload({ claim: CLAIM, txHash: TX }))

		expect(requests.map((r) => r.method)).toEqual([
			'eth_getTransactionReceipt',
			'eth_getTransactionByHash',
			'eth_blockNumber',
		])
		for (const { req } of requests) {
			expect(req.url).toBe('https://base-sepolia.example/rpc/test-key')
			expect(req.method).toBe('POST')
			expect(req.multiHeaders['api-key']).toBeUndefined()
			expect(req.multiHeaders['content-type'].values).toEqual(['application/json'])
			expect(req.timeout.seconds).toBe(8n)
			expect(req.cacheSettings.store).toBe(true)
			expect(req.cacheSettings.maxAge.seconds).toBe(60n)
		}

		expect(writes).toHaveLength(1)
		const write = writes[0]
		expect(write.computeConfig?.computeLimit).toBe(200_000)
		const accounts = write.remainingAccounts.map((a) => [new PublicKey(a.publicKey).toBase58(), a.isWritable])
		expect(accounts).toEqual([
			[CONFIG.forwarderState, false],
			[FORWARDER_AUTHORITY, false],
			[CONFIG.witnessConfig, false],
			[CLAIM, true],
		])

		const { accountHash, payload: report } = splitReport(write)
		const keys = Buffer.concat(write.remainingAccounts.map((a) => Buffer.from(a.publicKey)))
		expect(Buffer.from(accountHash).toString('hex')).toBe(createHash('sha256').update(keys).digest('hex'))

		expect(report.length).toBe(106)
		const decoded = witnessReportCodec.decode(report)
		expect(decoded.ver).toBe(1)
		expect(decoded.chainId).toBe(84532n)
		expect(Buffer.from(decoded.txHash).toString('hex')).toBe(TX.slice(2))
		expect(Buffer.from(decoded.from).toString('hex')).toBe(RECEIPT.from.slice(2))
		expect(Buffer.from(decoded.to).toString('hex')).toBe(RECEIPT.to.slice(2))
		expect(decoded.valueWei).toBe(10n ** 18n)
		expect(decoded.block).toBe(0x2d95d9en)
		expect(decoded.status).toBe(1)

		expect(out.Success).toBe(true)
		expect(out.Confirmations).toBe('10')
		expect(out.Signature.length).toBeGreaterThan(80)
	})

	test('a reverted transaction is recorded with status 0', () => {
		const { runtime, writes, payload } = setup({ receipt: { ...RECEIPT, status: '0x0' } })
		const out = onWitnessRequest(runtime, payload({ claim: CLAIM, txHash: TX }))
		expect(witnessReportCodec.decode(splitReport(writes[0]).payload).status).toBe(0)
		expect(out.Success).toBe(false)
	})

	test('a contract creation records the zero address as `to`', () => {
		const { runtime, writes, payload } = setup({ receipt: { ...RECEIPT, to: null } })
		onWitnessRequest(runtime, payload({ claim: CLAIM, txHash: TX }))
		expect(witnessReportCodec.decode(splitReport(writes[0]).payload).to).toEqual(new Array(20).fill(0))
	})

	test('refuses with too few confirmations', () => {
		const { runtime, writes, payload } = setup({ head: '0x2d95d9f' })
		expect(() => onWitnessRequest(runtime, payload({ claim: CLAIM, txHash: TX }))).toThrow(/Only 1 confirmations/)
		expect(writes).toHaveLength(0)
	})

	test('refuses a transaction from another chain', () => {
		const { runtime, writes, payload } = setup({ tx: { ...TXN, chainId: '0xaa36a7' } })
		expect(() => onWitnessRequest(runtime, payload({ claim: CLAIM, txHash: TX }))).toThrow(/chain 11155111/)
		expect(writes).toHaveLength(0)
	})

	test('refuses an unknown transaction', () => {
		const { runtime, payload } = setup({ receipt: null })
		expect(() => onWitnessRequest(runtime, payload({ claim: CLAIM, txHash: TX }))).toThrow()
	})

	test('rejects a malformed payload', () => {
		const { runtime, payload } = setup()
		expect(() => onWitnessRequest(runtime, payload({ claim: CLAIM, txHash: '0x1234' }))).toThrow()
		expect(() => onWitnessRequest(runtime, payload({ claim: 'not-a-key', txHash: TX }))).toThrow()
	})

	test('throws unless the write succeeds', () => {
		const { runtime, payload } = setup({}, 'TX_STATUS_FATAL')
		expect(() => onWitnessRequest(runtime, payload({ claim: CLAIM, txHash: TX }))).toThrow(/boom/)
		expect(SolanaTxStatus.SUCCESS).toBe(2)
	})
})
