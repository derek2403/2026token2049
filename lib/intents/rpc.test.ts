import { test } from "node:test";
import assert from "node:assert/strict";
import { EthRpc } from "../soda";
import { baseRpc, getReceipt, isPlainAddress, parseReceipt } from "./rpc";

// No network: EthRpc.call is stubbed per test.
class StubRpc extends EthRpc {
  constructor(private readonly results: Record<string, unknown>) {
    super("http://stub.invalid");
  }
  override async call<T>(method: string): Promise<T> {
    return this.results[method] as T;
  }
}

test("baseRpc uses BASE_RPC_URL, else the public Base Sepolia endpoint", () => {
  const saved = process.env.BASE_RPC_URL;
  try {
    delete process.env.BASE_RPC_URL;
    assert.equal(baseRpc().endpoint, "https://sepolia.base.org");
    process.env.BASE_RPC_URL = "https://example.invalid/rpc";
    assert.equal(baseRpc().endpoint, "https://example.invalid/rpc");
    assert.equal(baseRpc({ url: "https://override.invalid" }).endpoint, "https://override.invalid");
  } finally {
    if (saved === undefined) delete process.env.BASE_RPC_URL;
    else process.env.BASE_RPC_URL = saved;
  }
});

test("parseReceipt and getReceipt", async () => {
  const raw = { transactionHash: "0xABC", status: "0x1", blockNumber: "0x10", gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00" };
  assert.deepEqual(parseReceipt(raw), { txHash: "0xabc", status: 1, blockNumber: 16n, gasUsed: 21000n, effectiveGasPrice: 1_000_000_000n });
  assert.equal(parseReceipt({ ...raw, status: "0x0" }).status, 0);
  assert.equal(await getReceipt(new StubRpc({ eth_getTransactionReceipt: null }), "0x1"), null);
  assert.equal((await getReceipt(new StubRpc({ eth_getTransactionReceipt: raw }), "0x1"))!.blockNumber, 16n);
});

test("isPlainAddress: only eth_getCode == 0x passes", async () => {
  assert.equal(await isPlainAddress(new StubRpc({ eth_getCode: "0x" }), "0x" + "11".repeat(20)), true);
  assert.equal(await isPlainAddress(new StubRpc({ eth_getCode: "0x6080" }), new Uint8Array(20)), false);
  // EIP-7702 delegation designator
  assert.equal(await isPlainAddress(new StubRpc({ eth_getCode: "0xef0100" + "22".repeat(20) }), "0x" + "11".repeat(20)), false);
});
