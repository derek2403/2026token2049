// Runs the handler against the SDK's test runtime: Solana RPC, the MPC coordinator
// and the Solana write are mocked. `bun test` from cre/soda-signer.
import { describe, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { bytesToBase64 } from '@chainlink/cre-sdk'
import {
	HttpActionsMock,
	newTestRuntime,
	REPORT_METADATA_HEADER_LENGTH,
	SolanaMock,
	type SolanaWriteReportMockInput,
	test,
} from '@chainlink/cre-sdk/test'
import { PublicKey } from '@solana/web3.js'
import { newSodaCreSignerMock } from './contracts/solana/ts/generated/SodaCreSigner_mock'
import { signerReportCodec } from './contracts/solana/ts/generated'
import simulationConfig from './config.simulation.json'
import {
	base64ToBytes,
	type Config,
	configSchema,
	forwarderAuthority,
	onSignRequest,
	SODA_COMMITTEE,
	SODA_PROGRAM_ID,
	submitterPda,
} from './workflow'

const CONFIG: Config = configSchema.parse(simulationConfig)
const SOLANA_DEVNET = 16423721717087811551n
const SIG_REQUEST = 'GkVu1AXhnFaUhcgW4sZXzDstHwPZ7CmfHkmrSXqHPKTx'
const R = 'ab'.repeat(32)
const S = '0c'.repeat(32)

// A SigRequest laid out per HANDOVER §1.4 with 5 derivation-seed bytes.
const sigRequestData = (completed: boolean) => {
	const seeds = 5
	const buf = Buffer.alloc(8 + 1 + 32 + 32 + 64 + 4 + seeds + 32 + 32 + 4 + 8 + 1 + 64 + 1)
	Buffer.from('3617d2807be9f1e9', 'hex').copy(buf, 0)
	const seedsAt = 8 + 1 + 32 + 32 + 64
	buf.writeUInt32LE(seeds, seedsAt)
	buf[seedsAt + 4 + seeds + 32 + 32 + 4 + 8] = completed ? 1 : 0
	return buf.toString('base64')
}

type Opts = { owner?: string; completed?: boolean; v?: number }

const setup = (opts: Opts = {}) => {
	const requests: any[] = []
	const http = HttpActionsMock.testInstance()
	http.sendRequest = (req) => {
		requests.push(req)
		const result = req.url.endsWith('/sign')
			? { r: R, s: S, v: opts.v ?? 1 }
			: {
					jsonrpc: '2.0',
					id: 1,
					result: {
						value: {
							owner: opts.owner ?? SODA_PROGRAM_ID,
							data: [sigRequestData(opts.completed ?? false), 'base64'],
						},
					},
				}
		return { statusCode: 200, body: bytesToBase64(new TextEncoder().encode(JSON.stringify(result))) }
	}

	const writes: SolanaWriteReportMockInput[] = []
	const signer = newSodaCreSignerMock(SolanaMock.testInstance(SOLANA_DEVNET), CONFIG.receiverProgramId)
	signer.writeReport = (input) => {
		writes.push(input)
		return { txStatus: 'TX_STATUS_SUCCESS', txSignature: bytesToBase64(new Uint8Array(64).fill(7)) }
	}

	const secrets = new Map([
		[
			'main',
			new Map([
				['SOLANA_RPC_URL', 'https://solana-devnet.example/rpc'],
				['MPC_COORDINATOR_TOKEN', 'test-token'],
			]),
		],
	])
	const runtime = newTestRuntime<Config>(secrets, {}, CONFIG)
	const payload = { input: new TextEncoder().encode(JSON.stringify({ sigRequest: SIG_REQUEST })) } as any
	return { runtime, requests, writes, payload }
}

describe('onSignRequest', () => {
	test('reads the SigRequest, gets the MPC signature and writes a 98-byte SignerReport', () => {
		const { runtime, requests, writes, payload } = setup({ v: 28 })
		const out = onSignRequest(runtime, payload)

		expect(requests).toHaveLength(2)
		expect(requests[0].url).toBe('https://solana-devnet.example/rpc')
		const sign = requests[1]
		expect(sign.url).toBe(`${CONFIG.coordinatorUrl}/sign`)
		expect(sign.multiHeaders.authorization.values).toEqual(['Bearer test-token'])
		expect(JSON.parse(new TextDecoder().decode(sign.body))).toEqual({ sigRequestPubkey: SIG_REQUEST })
		expect(sign.timeout.seconds).toBe(30n)
		expect(sign.cacheSettings.maxAge.seconds).toBe(60n)

		expect(writes).toHaveLength(1)
		const write = writes[0]
		expect(write.computeConfig?.computeLimit).toBe(200_000)
		const accounts = write.remainingAccounts.map((a) => [new PublicKey(a.publicKey).toBase58(), a.isWritable])
		expect(accounts).toEqual([
			[CONFIG.forwarderState, false],
			[forwarderAuthority(CONFIG).toBase58(), false],
			[CONFIG.signerConfig, false],
			[SIG_REQUEST, true],
			[SODA_COMMITTEE, false],
			[submitterPda(CONFIG).toBase58(), false],
			[SODA_PROGRAM_ID, false],
		])

		// rawReport = metadata header | accountHash (32) | u32 len | payload
		const raw = write.report.rawReport.subarray(REPORT_METADATA_HEADER_LENGTH)
		const keys = Buffer.concat(write.remainingAccounts.map((a) => Buffer.from(a.publicKey)))
		expect(Buffer.from(raw.subarray(0, 32)).toString('hex')).toBe(createHash('sha256').update(keys).digest('hex'))
		const len = new DataView(raw.buffer, raw.byteOffset + 32, 4).getUint32(0, true)
		expect(len).toBe(98)
		const report = signerReportCodec.decode(raw.subarray(36, 36 + len))
		expect(report.ver).toBe(1)
		expect(report.sigRequest).toBe(SIG_REQUEST)
		expect(Buffer.from(report.signature).toString('hex')).toBe(R + S)
		expect(report.recoveryId).toBe(1)
		expect(out.Signature.length).toBeGreaterThan(80)
	})

	test('refuses a completed or foreign SigRequest before calling the coordinator', () => {
		for (const opts of [{ completed: true }, { owner: '11111111111111111111111111111111' }]) {
			const { runtime, requests, writes, payload } = setup(opts)
			expect(() => onSignRequest(runtime, payload)).toThrow()
			expect(requests).toHaveLength(1)
			expect(writes).toHaveLength(0)
		}
	})

	test('base64ToBytes matches Buffer', () => {
		for (const n of [0, 1, 2, 3, 98, 347]) {
			const bytes = new Uint8Array(n).map((_, i) => (i * 37) & 0xff)
			expect(Array.from(base64ToBytes(Buffer.from(bytes).toString('base64')))).toEqual(Array.from(bytes))
		}
	})
})
