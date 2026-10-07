// Cross-chain signing demo (ported from frontier apps/web, prior work): one
// Phantom approval on Solana moves a Base Sepolia account. Browser-safe.

import type { Idl } from "@coral-xyz/anchor";
import { hexToBytes } from "@noble/hashes/utils";
import ethDemoIdlJson from "../../../idl/eth_demo.json";
import {
  AAVE_BORROW_AMOUNT_USDC,
  AAVE_BORROW_GAS_LIMIT,
  AAVE_BORROW_MIN_BALANCE_WEI,
  AAVE_DEPOSIT_GAS_LIMIT,
  AAVE_DEPOSIT_MIN_BALANCE_WEI,
  AAVE_V3_BASE_SEPOLIA,
  addressToBytes,
  borrowCalldata,
  depositEthCalldata,
} from "@/lib/soda/aave";

export const ETH_DEMO_IDL = ethDemoIdlJson as unknown as Idl;
/** eth_demo on Solana devnet: sign_eth_transfer builds the EVM tx and CPIs soda::request_signature. */
export const ETH_DEMO_PROGRAM_ID = (ethDemoIdlJson as { address: string }).address;
export const SODA_CRE_SIGNER_ID = "2cgtuK2Y9BQ8uMbVpYwM9FZ7TVkSqu9xegNTyBp3taxM";
export const SODA_WITNESS_ID = "5v97wLYgMzyfQfpZWGQ6uPXTHh4JsJitUXPReYy2uuTp";

export const DEMO_CHAIN = {
  key: "base-sepolia",
  name: "Base Sepolia",
  chainId: 84_532n,
} as const;

export const AAVE = AAVE_V3_BASE_SEPOLIA;

/** SigRequest::MAX_SEEDS_LEN in soda. */
export const MAX_SEEDS_LEN = 64;

export type ActionKey = "transfer" | "deposit" | "borrow";

export type TxSpec = {
  to: Uint8Array;
  valueWei: bigint;
  data: Uint8Array;
  gasLimit: bigint;
  /** What the derived address must hold before this can be broadcast. */
  minBalanceWei: bigint;
};

export type ActionDef = {
  key: ActionKey;
  title: string;
  protocol: string;
  callName: string;
  button: string;
  description: string;
  build: (derived: Uint8Array, input: { to: Uint8Array; valueWei: bigint }) => TxSpec;
};

export const USDC_PER_CLICK = `${(Number(AAVE_BORROW_AMOUNT_USDC) / 1e6).toFixed(2)} USDC`;

export const ACTIONS: Record<ActionKey, ActionDef> = {
  transfer: {
    key: "transfer",
    title: "Send ETH",
    protocol: "Base Sepolia",
    callName: "plain value transfer · no calldata",
    button: "Sign & send",
    description: "Move ETH from your derived address to any address. No contract, 21,000 gas.",
    build: (_derived, input) => ({
      to: input.to,
      valueWei: input.valueWei,
      data: new Uint8Array(0),
      gasLimit: 21_000n,
      minBalanceWei: input.valueWei + 200_000_000_000_000n,
    }),
  },
  deposit: {
    key: "deposit",
    title: "Deposit ETH into Aave V3",
    protocol: "Aave V3",
    callName: "WrappedTokenGatewayV3.depositETH",
    button: "Sign & deposit 0.0001 ETH",
    description: "Supplies 0.0001 ETH. The derived address receives aWETH: a lending position owned by a Solana wallet.",
    build: (derived) => ({
      to: addressToBytes(AAVE.WETH_GATEWAY),
      valueWei: 100_000_000_000_000n,
      data: depositEthCalldata(AAVE, derived),
      gasLimit: AAVE_DEPOSIT_GAS_LIMIT,
      minBalanceWei: AAVE_DEPOSIT_MIN_BALANCE_WEI,
    }),
  },
  borrow: {
    key: "borrow",
    title: "Borrow USDC on Aave V3",
    protocol: "Aave V3",
    callName: "Pool.borrow",
    button: `Sign & borrow ${USDC_PER_CLICK}`,
    description: `Borrows ${USDC_PER_CLICK} against the aWETH. Only the position's owner can do this.`,
    build: (derived) => ({
      to: addressToBytes(AAVE.POOL),
      valueWei: 0n,
      data: borrowCalldata(AAVE, AAVE_BORROW_AMOUNT_USDC, derived),
      gasLimit: AAVE_BORROW_GAS_LIMIT,
      minBalanceWei: AAVE_BORROW_MIN_BALANCE_WEI,
    }),
  },
};

export function hex0x(b: Uint8Array): string {
  return "0x" + Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
}

export function fromHex(h: string): Uint8Array {
  return hexToBytes(h.replace(/^0x/, ""));
}

/** wei → short ETH string without trailing zeros. */
export function formatEth(wei: bigint | string | null | undefined, dp = 6): string {
  if (wei == null || wei === "") return "—";
  const v = BigInt(wei);
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").slice(0, dp).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Decimal ETH string → wei, exact (no Number rounding). */
export function parseEth(s: string): bigint | null {
  const t = s.trim();
  if (!/^\d*\.?\d+$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  return BigInt(whole || "0") * 10n ** 18n + BigInt((frac + "0".repeat(18)).slice(0, 18));
}

// ------------------------------------------------------------ API shapes

export type DemoAttribution = {
  via: "chainlink-cre" | "mpc-subscriber" | "pending";
  finalizeTx: string | null;
  slot: number | null;
  label: string;
  forwarder?: "mock" | "production";
  explorer?: string;
};

export type DemoStatus = {
  sigRequest: string;
  exists: boolean;
  completed: boolean;
  attribution: DemoAttribution;
  /** The payload `cre workflow simulate soda-signer` takes (cre/payloads/sign.json). */
  crePayload: { sigRequest: string };
  receipt?: { status: 0 | 1; blockNumber: string; gasUsed: string } | null;
};

export type DemoFinalizeResponse =
  | { pending: true; attribution: DemoAttribution }
  | {
      pending: false;
      ethTxHash: string;
      signedHex: string;
      ethAddress: string;
      alreadyBroadcast: boolean;
      attribution: DemoAttribution;
    };

export type DemoAccount = {
  address: string;
  balanceWei: string;
  aave: {
    aWethWei: string;
    usdcUnits: string;
    debtUsdcUnits: string;
    totalCollateralBase: string;
    availableBorrowsBase: string;
    healthFactor: string;
    supplyApy: number;
    borrowApr: number;
  } | null;
  aaveError?: string;
};

export type DemoPrepare = {
  nonce: string;
  gasPriceWei: string;
  gasEstimate: string;
};
