// Operator CLI for SODA Witness. Run from the repo root:
//   npx tsx scripts/witness-cli.ts <command> [flags]
// `help` lists the commands. Only init-config, set-config and open-claim send transactions.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { AnchorProvider, BN, Program, Wallet, type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { config as loadDotenv } from "dotenv";
import witnessIdl from "../idl/soda_witness.json";
import { solverKeypair } from "../services/solver/src/env";

const ROOT = resolve(__dirname, "..");
const DEFAULT_ADMIN_KEYPAIR = "~/.config/solana/token2049-deployer.json";
const DEFAULT_USER_KEYPAIR = "~/.config/solana/id.json";
const DEFAULT_PAYLOAD = resolve(ROOT, "cre/payloads/claim.json");
const BASE_SEPOLIA = 84532;

const FORWARDERS = {
  // `cre workflow simulate` always writes through this one.
  mock: {
    program: new PublicKey("7kuEAA3mSC1Tz8gQjnvH7bKFda9xSPRRin9SZbH49cNK"),
    state: new PublicKey("5Tipz3yhTBdVsDbaBxZkrp7Gjf3brGq5SKkxReefPMP7"),
  },
  // Deployed workflows (DON signatures checked).
  production: {
    program: new PublicKey("CXsKEJcs25TQEYU2e5jZ8QTPE3ffMLZhH6BWHrdcCCB5"),
    state: new PublicKey("8QoomCQyPSkJ8WopJbX9B4HyvrFzziwvJdU8hZE6DCr9"),
  },
} as const;

const HELP = `SODA Witness CLI

  init-config   [--forwarder mock|production] [--workflow-owner 0x..] [--workflow-name hex]   admin
  set-config    [--forwarder mock|production] [--workflow-owner 0x..] [--workflow-name hex]   admin
  open-claim    <txHash> [--chain-id N] [--payload path] [--dry-run] [--solver-key]           requester
  show-claim    <claim>
  show-config
  claim-pda     <txHash> [--chain-id N] [--requester pubkey] [--solver-key]

--forwarder defaults to mock. --workflow-owner (20 bytes) and --workflow-name (10 bytes, hex):
init-config defaults them to zeros, which skips that metadata check; set-config keeps the
current values unless given (pass all-zero hex to clear one). The production forwarder
requires a non-zero workflow owner. open-claim writes the claim into
${DEFAULT_PAYLOAD} (or --payload); --dry-run prints and writes without sending.

Keypairs: admin uses --admin-keypair, ADMIN_KEYPAIR or ${DEFAULT_ADMIN_KEYPAIR}; requester
uses --keypair, USER_KEYPAIR or ${DEFAULT_USER_KEYPAIR}; --solver-key uses the intents solver key
(SOLVER_KEYPAIR_JSON, SOL_KEY or SOLVER_KEYPAIR_PATH), which a claim for intents'
credit_solver_from_claim needs. RPC: SOLANA_RPC_URL or devnet.`;

const { values: flags, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: true,
  options: {
    keypair: { type: "string" },
    "admin-keypair": { type: "string" },
    forwarder: { type: "string" },
    "workflow-owner": { type: "string" },
    "workflow-name": { type: "string" },
    "chain-id": { type: "string" },
    requester: { type: "string" },
    payload: { type: "string" },
    "dry-run": { type: "boolean" },
    "solver-key": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const pos = (i: number, what: string): string => {
  const v = positionals[i];
  if (!v) throw new Error(`missing <${what}>`);
  return v;
};

// ---------------------------------------------------------------- context

if (process.env.NO_DOTENV !== "1" && existsSync(resolve(ROOT, ".env"))) {
  loadDotenv({ path: resolve(ROOT, ".env"), quiet: true });
}
// Confirmations go over SOLANA_WS_URL: keyed HTTP providers (Alchemy) have no signatureSubscribe.
const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", {
  commitment: "confirmed",
  wsEndpoint: process.env.SOLANA_WS_URL || "wss://solana-devnet.api.onfinality.io/public-ws",
});
const IDL = witnessIdl as unknown as Idl;
const PROGRAM_ID = new PublicKey(IDL.address);

function keypairFromFile(path: string): Keypair {
  const p = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(path);
  if (!existsSync(p)) throw new Error(`keypair file not found: ${p}`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
}
const adminKeypair = () => keypairFromFile(flags["admin-keypair"] ?? process.env.ADMIN_KEYPAIR ?? DEFAULT_ADMIN_KEYPAIR);
const userKeypair = () =>
  flags["solver-key"] ? solverKeypair() : keypairFromFile(flags.keypair ?? process.env.USER_KEYPAIR ?? DEFAULT_USER_KEYPAIR);

function program(signer: Keypair): Program {
  return new Program(IDL, new AnchorProvider(conn, new Wallet(signer), { commitment: "confirmed" }));
}

const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const explorerAddress = (a: PublicKey | string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;

function hexBytes(hex: string | undefined, len: number, what: string): number[] {
  if (hex === undefined) return new Array(len).fill(0);
  const h = hex.replace(/^0x/i, "");
  if (!new RegExp(`^[0-9a-fA-F]{${len * 2}}$`).test(h)) throw new Error(`${what} must be ${len} bytes of hex`);
  return Array.from(Buffer.from(h, "hex"));
}
const toHex = (b: ArrayLike<number>) => `0x${Buffer.from(Uint8Array.from(b)).toString("hex")}`;

function chainId(): number {
  const n = Number(flags["chain-id"] ?? BASE_SEPOLIA);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("--chain-id must be a positive integer");
  return n;
}

const configPda = () => PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID)[0];

function claimPda(requester: PublicKey, chain: number, txHash: number[]): PublicKey {
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(BigInt(chain));
  return PublicKey.findProgramAddressSync([Buffer.from("claim"), requester.toBuffer(), le, Buffer.from(txHash)], PROGRAM_ID)[0];
}

type ConfigAccount = {
  admin: PublicKey;
  forwarderProgram: PublicKey;
  forwarderState: PublicKey;
  workflowOwner: number[];
  workflowName: number[];
};
type ClaimAccount = {
  requester: PublicKey;
  chainId: BN;
  txHash: number[];
  status: number;
  from: number[];
  to: number[];
  valueWei: BN;
  block: BN;
  success: boolean;
  recordedAt: BN;
};

async function fetchDecoded<T>(name: "Config" | "Claim", key: PublicKey): Promise<T | null> {
  const info = await conn.getAccountInfo(key);
  if (!info || !info.owner.equals(PROGRAM_ID)) return null;
  // Program camelCases the IDL, so its coder knows "config" / "claim".
  return program(Keypair.generate()).coder.accounts.decode<T>(name[0].toLowerCase() + name.slice(1), info.data);
}

function forwarderPair() {
  const name = flags.forwarder ?? "mock";
  if (name !== "mock" && name !== "production") throw new Error("--forwarder must be mock or production");
  return { name, ...FORWARDERS[name] };
}

// ---------------------------------------------------------------- commands

async function writeConfig(kind: "init" | "set") {
  const admin = adminKeypair();
  const fwd = forwarderPair();
  // set_config overwrites every field, so set-config keeps the current pins unless a flag is given.
  const cur = kind === "set" ? await fetchDecoded<ConfigAccount>("Config", configPda()) : null;
  if (kind === "set" && !cur) throw new Error(`Config ${configPda().toBase58()} not initialised: run init-config`);
  const owner =
    flags["workflow-owner"] !== undefined || !cur
      ? hexBytes(flags["workflow-owner"], 20, "--workflow-owner")
      : Array.from(cur.workflowOwner);
  const name =
    flags["workflow-name"] !== undefined || !cur
      ? hexBytes(flags["workflow-name"], 10, "--workflow-name")
      : Array.from(cur.workflowName);
  // The production forwarder accepts DON-signed reports from any workflow; only the owner pin stops
  // another team's workflow from writing into our claims.
  if (fwd.name === "production" && owner.every((b) => b === 0)) {
    throw new Error("--forwarder production needs a non-zero workflow_owner: pass the deployed workflow's --workflow-owner");
  }
  const args = [fwd.program, fwd.state, owner, name] as const;
  const p = program(admin);
  const builder = kind === "init" ? p.methods.initConfig(...args) : p.methods.setConfig(...args);
  const sig = await builder.accountsPartial({ admin: admin.publicKey, config: configPda() }).rpc();
  console.log(`${kind}-config: admin ${admin.publicKey.toBase58()}, ${fwd.name} forwarder ${fwd.program.toBase58()}`);
  console.log(`  workflow_owner ${toHex(owner)}  workflow_name ${toHex(name)}`);
  console.log(`  tx ${explorerTx(sig)}`);
}

async function showConfig() {
  const cfg = await fetchDecoded<ConfigAccount>("Config", configPda());
  if (!cfg) return console.log(`Config ${configPda().toBase58()} not initialised: run init-config`);
  const fwd = Object.entries(FORWARDERS).find(([, f]) => f.program.equals(cfg.forwarderProgram))?.[0] ?? "custom";
  console.log(`Config ${configPda().toBase58()}`);
  console.log(`  admin              ${cfg.admin.toBase58()}`);
  console.log(`  forwarder_program  ${cfg.forwarderProgram.toBase58()} (${fwd})`);
  console.log(`  forwarder_state    ${cfg.forwarderState.toBase58()}`);
  console.log(`  workflow_owner     ${toHex(cfg.workflowOwner)}`);
  console.log(`  workflow_name      ${toHex(cfg.workflowName)}`);
}

function writePayload(claim: PublicKey, txHash: string) {
  const path = flags.payload ? resolve(flags.payload) : DEFAULT_PAYLOAD;
  writeFileSync(path, `${JSON.stringify({ claim: claim.toBase58(), txHash }, null, 2)}\n`);
  console.log(`  wrote ${path}`);
}

async function openClaim(txHashArg: string) {
  const txHash = txHashArg.toLowerCase();
  const hash = hexBytes(txHash, 32, "<txHash>");
  const chain = chainId();
  const requester = userKeypair();
  const claim = claimPda(requester.publicKey, chain, hash);
  console.log(`claim ${claim.toBase58()}  requester ${requester.publicKey.toBase58()}  chain ${chain}  tx ${txHash}`);
  if (flags["dry-run"]) {
    console.log("  dry run: nothing sent");
  } else if (await conn.getAccountInfo(claim)) {
    console.log("  already open");
  } else {
    const sig = await program(requester)
      .methods.openClaim(new BN(chain), hash)
      .accountsPartial({ requester: requester.publicKey, claim })
      .rpc();
    console.log(`  tx ${explorerTx(sig)}`);
  }
  writePayload(claim, txHash);
}

async function showClaim(addr: string) {
  const key = new PublicKey(addr);
  const c = await fetchDecoded<ClaimAccount>("Claim", key);
  if (!c) return console.log(`no Claim at ${addr}`);
  const recorded = c.status === 1;
  console.log(`Claim ${addr}  ${recorded ? "Recorded" : "Pending"}`);
  console.log(`  requester    ${c.requester.toBase58()}`);
  console.log(`  chain_id     ${c.chainId.toString()}`);
  console.log(`  tx_hash      ${toHex(c.txHash)}`);
  if (recorded) {
    console.log(`  success      ${c.success}`);
    console.log(`  from         ${toHex(c.from)}`);
    console.log(`  to           ${toHex(c.to)}`);
    console.log(`  value_wei    ${c.valueWei.toString()}`);
    console.log(`  block        ${c.block.toString()}`);
    console.log(`  recorded_at  ${new Date(c.recordedAt.toNumber() * 1000).toISOString()}`);
  }
  console.log(`  ${explorerAddress(addr)}`);
}

function showClaimPda(txHash: string) {
  const requester = flags.requester ? new PublicKey(flags.requester) : userKeypair().publicKey;
  console.log(claimPda(requester, chainId(), hexBytes(txHash, 32, "<txHash>")).toBase58());
}

async function main() {
  const cmd = positionals[0];
  if (!cmd || cmd === "help" || flags.help) return console.log(HELP);
  switch (cmd) {
    case "init-config":
      return writeConfig("init");
    case "set-config":
      return writeConfig("set");
    case "show-config":
      return showConfig();
    case "open-claim":
      return openClaim(pos(1, "txHash"));
    case "show-claim":
      return showClaim(pos(1, "claim"));
    case "claim-pda":
      return showClaimPda(pos(1, "txHash"));
    default:
      throw new Error(`unknown command ${cmd}; try help`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  if (e?.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
