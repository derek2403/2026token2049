# Wiring the RFQ (NEAR-style) flow into the page

For the UI session, which owns `app/page.tsx`, `app/layout.tsx`, `app/globals.css` and the existing `app/components/*`. None of those files were touched. The relay, the panel and the API fields are ready, so the UI work is three small edits: mount the panel, label RFQ rows, and show the slot-based signing time.

## What exists

| File | What it is |
|---|---|
| `app/components/RfqPanel.tsx` (new) | Self-contained client component for the "RFQ · NEAR-style" tab. It shows the vault balance, deposit (first trade only) and withdraw, the quotes list (best highlighted, expiry countdown), the exact message being signed, and Phantom `signMessage` then `publish_intent`. Tailwind utilities only, using the existing tokens (`bg-card`, `bg-panel`, `text-muted`, `text-faint`, `bg-accent`, `bg-accent-soft`, `text-good`, `text-warn`, `text-bad`). The frame matches `SwapForm`: square `bg-card` sections stacked with `gap-0.5`, plus a `rounded-full` h-14 primary button. |
| `app/lib/rfq-client.ts` (new) | Relay JSON-RPC client (`relayQuote`, `relayPublish`, `relayStatus`), deposit/withdraw transaction builders, and the hooks `useUserVault`, `useRfqQuotes` and `useNow`. |
| `app/api/rfq/route.ts` + `app/lib/server/rfq-relay.ts` (new) | The relay (Message Bus): `POST /api/rfq`, JSON-RPC `quote`, `publish_intent` and `get_status`. |
| `app/lib/server/payout.ts` (new) | The `/api/payout` logic, shared with `get_status`. It adds per-step `slot`, the `signing` timing and `isRfq`. |

`RfqPanel` needs only the providers `layout.tsx` already has: wallet, connection and wallet modal. It uses neither the toast context nor `useOrder`.

## 1. `app/page.tsx`: mount it as a tab next to the swap flow

Put a two-tab switch above the form in `<main>`. Name the existing flow's tab "Auction".

```tsx
import { RfqPanel } from "@/app/components/RfqPanel";

const [mode, setMode] = useState<"auction" | "rfq">("auction");

<main className="…unchanged…">
  <div className="mb-3 flex gap-1 text-sm">
    <button onClick={() => setMode("auction")} className={mode === "auction" ? "…active…" : "…"}>Auction</button>
    <button onClick={() => setMode("rfq")} className={mode === "rfq" ? "…active…" : "…"}>RFQ · NEAR-style</button>
  </div>
  {mode === "auction" ? (
    <SwapForm onOpened={opened} />
  ) : (
    <RfqPanel onOrder={(intent) => opened(intent, true)} />
  )}
</main>
```

- **`onOrder(intent: string)`** fires after the relay reports that the winning solver settled the signed intent on Solana. `intent` is the Intent PDA (base58), the same kind of key `SwapForm` passes to `opened`. `opened(intent, true)` makes it the active order and shows the `OrderTracker` pill. From there, `onDetails` opens `OrderDrawer` as it does for auction orders. Pass `confirmed = true`: by then the execute transaction is confirmed.
- **Notice text.** `opened` currently says "SOL locked in escrow. Solvers are bidding.", which is wrong for RFQ: the intent is already filled. Either add a third argument, or call `notify({ kind: "info", title: "Signed intent settled", body: "A solver filled it from your vault. ETH is on its way.", intent })` in the RFQ branch.
- **Measured first step.** Before calling `onOrder`, the panel calls `saveOrder({ intent, openSig: tx, sentAt: signedAt, observed: { open: settledAt } })`. `withMeasuredTimes` then shows the first step ("Signed intent settled by solver XXXX…YYYY") as "confirmed in N ms", measured from signing to settlement. No change is needed for that.
- **Width.** The panel is `w-full`, so it fills the 596 px `main` column like `SwapForm`.

**Environment.** The relay reads `SOLVER_URLS`, the same variable `/api/quotes` uses. Entries can be base URLs, or base URLs ending in `/quote` (that suffix is stripped). If `SOLVER_URLS` is unset, `quote` returns HTTP 503 with JSON-RPC error `-32001`, "No solvers configured: set SOLVER_URLS …", and the panel shows that text above its quotes list.

## 2. `app/components/ActivityPanel.tsx`: label RFQ intents

`AccountBox` (Activity tab) renders `ActivityPanel`, so the label only needs to go in `ActivityRow`. That component already has the decoded account as `a = row.account`:

```tsx
import { isRfqIntent } from "@/lib/intents";

const rfq = isRfqIntent(a);
// in the subtitle line, currently `{formatDateTime(...)} · SOL → ETH`:
<div className="text-xs text-faint">
  {formatDateTime(Number(a.auctionStart) * 1000)} · SOL → ETH · {rfq ? "RFQ" : "Auction"}
</div>
// or as a pill next to <StatusPill>:
{rfq && <span className="rounded-full bg-accent-soft px-2 py-0.5 font-medium text-accent">RFQ</span>}
```

`isRfqIntent` is true for a Filled intent with `auction_duration == 0` that was filled in the same second it started, which is what `execute_signed_intent` writes. It checks more than `auction_duration == 0` because `open_intent` also accepts a zero duration. Code that only has the `/api/payout` JSON can use `data.isRfq`; `OrderDrawer` could show the same label in its header next to `StatusPill`.

The status machine in `lib/intents/status.ts` already renames the first step of an RFQ intent to "Signed intent settled by solver XXXX…YYYY". It also drops the "Solver matched" step's timestamp, because that step is the same transaction.

## 3. `app/components/OrderDrawer.tsx`: slot-based signing time on "Signature verified"

**The bug.** "Committee signing" shows +0 ms, and "Signature verified" shows a bogus ~95 ms. `withMeasuredTimes` compares whole-second block times with browser wall-clock times. The fill transaction both matches the order and starts signing, so the +0 is not a measurement.

**What `/api/payout` now returns.** All new fields are additive; existing fields are unchanged (`app/lib/api-types.ts`):

```ts
isRfq: boolean;
signing?: {            // set once the first SigRequest is signed and both txs are indexed
  fromSlot: number;    // slot of the fill / execute_signed_intent tx that created the SigRequest
  fromTx: string;
  toSlot: number;      // slot of the finalize_signature tx (signature verified on Solana)
  toTx: string;
  slots: number;       // toSlot - fromSlot
  msApprox: number;    // slots × 400
  label: string;       // "≈2.8 s (7 slots)"
};
steps: PayoutStep[];   // Step & { slot?, signingSlots?, signingMsApprox? }
// every Solana step with a tx carries `slot`;
// the "signed" step carries signingSlots and signingMsApprox once `signing` exists
```

Measured against devnet with the production build, for intent `FxDnJRshdAkPpLwaUfp3ykorHvcUiNfye13GWWn1H7h2`: fill at slot 508453563 and finalize at slot 508453570, so `signing.label` is "≈2.8 s (7 slots)" and the "signed" step has `signingSlots: 7, signingMsApprox: 2800`.

**The drawer change** is in the step list, inside `withMeasuredTimes(data.steps, local).map((s, i, all) => …)`. Replace the elapsed chip with:

```tsx
const timing =
  s.id === "signed" && data.signing
    ? data.signing.label                                   // "≈2.8 s (7 slots)"
    : s.id === "signing" || s.id === "signed"
      ? null                                               // never a fake +0 ms / +95 ms
      : s.elapsedMs !== undefined
        ? `${s.id === "open" ? "confirmed in " : "+"}${formatDuration(s.elapsedMs, s.chain === "solana")}`
        : null;

{timing && (
  <span
    className="rounded bg-panel px-1.5 py-0.5 font-mono text-muted"
    title={s.id === "signed" ? "Slots × 400 ms, from the fill tx's slot to the finalize tx's slot" : undefined}
  >
    {timing}
  </span>
)}
```

- **Committee signing** shows no number. If you want one there, show `data.signing.label` once it exists, or "in progress" while the step is active.
- **Before `signing` exists** (still signing, or the finalize tx is not indexed yet), show nothing rather than a wall-clock difference.
- **The clock column** (`formatClock(s.timestamp)`) can stay as it is. Only the duration chip changes.
- **Typing.** `withMeasuredTimes` (in `app/hooks/useOrder.ts`) is typed `Step[] → Step[]`, so `s.signingMsApprox` is not visible after it, although the field is still there at runtime. Read `data.signing` as above, or make the helper generic: `withMeasuredTimes<S extends Step>(steps: S[], …): (S & { measured?: boolean })[]`.

`OrderTracker` shows no durations, so it needs no change.

## Relay API (for reference)

`POST /api/rfq`, body `{"jsonrpc":"2.0","id":1,"method":…,"params":{…}}`. `params` may be an object or NEAR's one-element array.

| Method | Params | Result |
|---|---|---|
| `quote` | `exact_amount_in` (lamports, decimal string), `recipient?` (0x) | `[{quote_hash, solver, amount_out, expiration_time}]`, best first. Fans out to every `SOLVER_URLS` `/rfq/quote`, waits 500 ms after the first answer and at most 3 s, and keeps the quotes in memory until they expire. |
| `publish_intent` | `quote_hash`, `message` (base64), `public_key` (base58), `signature` (base64) | `{intent, tx}`. See the checks below. Each quote is used once. |
| `get_status` | `intent` (or `intent_hash`) | `{intent, status, order_status?, tx?, base_tx?}`. See the status mapping below. |

**`publish_intent` checks.** The relay:
- verifies the ed25519 signature off-chain (`@noble/curves`, strict);
- parses the canonical message, and requires the verifier to be this program and the signer to be `public_key`;
- requires sell == the quoted `amount_in`, receive-at-least == the quoted `amount_out`, and the recipient == the quoted recipient;
- requires the deadline to be in the future and no more than 600 s away;
- forwards the request to the quoting solver's `/rfq/execute`, then checks the returned intent equals `intentPda(user, nonce)`.

**`get_status` mapping** (from the `/api/payout` status):
- `completed` → `SETTLED`
- `broadcast` → `TX_BROADCASTED`
- `open`, `matched`, `signing` or `signed` → `PENDING`
- not found, not an intent account, `cancelled`, `expired` or `reverted` → `NOT_FOUND_OR_NOT_VALID`

An intent this relay published in the last 90 s that is not visible yet reads as `PENDING`.

Errors are JSON-RPC `error {code, message, data?}`:

| Code | Meaning | HTTP |
|---|---|---|
| -32700 | Body is not a JSON-RPC object | 400 |
| -32601 | Unknown method | 404 |
| -32602 | Invalid params | 400 |
| -32001 | No solvers configured | 503 |
| -32002 | No solver quoted (`data.failed` lists each solver's error) | 503 |
| -32010 | Unknown or expired quote | 410 |
| -32011 | Quote already used, or being published | 409 |
| -32012 | Bad signature or message | 400 |
| -32013 | Message does not match the quote | 400 |
| -32020 | Solver refused or failed; `data.solver_code` gives the reason, e.g. `program_NonceMoved` | 502 |
| -32021 | Solver returned a different intent address | 502 |
| -32030 | Could not read the intent (RPC error) | 502 |

## RfqPanel style rules (from the UI session; match the 1inch-style SwapForm.tsx)

Follow these when editing `RfqPanel.tsx`. `SwapForm.tsx` has the exact classes.
- **Primary button:** a white pill below the card, not inside a section: `mt-4 h-14 min-w-[262px] rounded-full bg-fg text-card font-[450]`. When disabled: `bg-white/[0.09] text-white/20`. Full width on mobile.
- **Corners:** cards and inner boxes are square, using `bg-panel` with no `rounded-xl`/`rounded-2xl`. Only pills and round buttons get `rounded-full`.
- **Amount row:**
  - the number at 32px / 40px, weight 450;
  - the "SOL" ticker right after it, with a 12px gap, `text-muted`, weight 400, not pushed to the right edge;
  - labels at 14px `text-muted`;
  - USD values right-aligned in `text-accent`.
- **Font:** weights 400, 450 and 500 only. Inter is the app font.
- **Popovers and inner surfaces:** `bg-subtle` (#19191C).

Already wired by the UI session:
- `page.tsx` has an "Auction | RFQ" pill-tab switch.
- `onOrder` calls `opened(intent, true, "rfq")`.
- ActivityPanel rows show "· RFQ" or "· Auction" via `isRfqIntent`.
- OrderDrawer shows an RFQ badge (`data.isRfq`), and the signed step uses `data.signing.label`.
- **Still to wire:** the `delivered` badge, once `/api/payout` returns `delivered`.

## Chainlink vs not: signer attribution and the "who does what" map

`/api/payout` (and so the relay's `get_status`) now also returns, additively:

```ts
signer: {                       // always present
  via: "chainlink-cre" | "mpc-subscriber" | "pending";
  finalizeTx?: string;          // the soda::finalize_signature tx
  forwarder?: "mock" | "production";   // chainlink-cre only
  label: string;                // "Signed via Chainlink CRE → SODA MPC" | "Signed via SODA MPC subscriber" | "pending"
};
signing?: { …unchanged…, via?, finalizeTx? };   // same values, once timing exists
providers: {
  quote: "Solvers (off-chain)",
  settle: "Solana program",
  sign: signer.via,
  deliver: "Base",
  depositProof: "Chainlink CRE (Witness)",
};
```

`via` is read from the finalize transaction itself (`app/lib/server/signer-attribution.ts`): it is `chainlink-cre` when that tx went through Chainlink's forwarder (`7kuEAA3m…` mock / `CXsKEJc…` production) into `soda_cre_signer` `2cgtuK2Y…`, which CPIs `soda::finalize_signature`; otherwise `mpc-subscriber`. Checked on devnet: intent `EzMV5oZt…` → `chainlink-cre` (mock forwarder), intent `FxDnJRsh…` → `mpc-subscriber`.

Suggested UI (OrderDrawer step list): a small badge on the "Signature verified" step, `bg-accent-soft text-accent` "Chainlink CRE" when `data.signer.via === "chainlink-cre"`, `bg-panel text-muted` "SODA MPC" for `mpc-subscriber`, linking `finalizeTx` to the Solana explorer. A legend row can render `providers` with a Chainlink mark on `depositProof` always and on `sign` only when it is `chainlink-cre`.

## "Start above market" (Dutch auction that visibly decays)

**Why the auction fills immediately today.** A solver's `/quote` is the most it will pay right now (its `maxOut`), and a solver fills as soon as `required_out <= maxOut`. `SwapForm` sets `start_out = best quote`, so at t = 0 the requirement already equals the solver's price and the fill is immediate. That is correct behaviour, not a bug.

**Option.** `app/lib/auction-start.ts` exports `presetParamsWithPremium(preset, quoteWei, nowSec, premiumBps)`. With `premiumBps = 0` it returns exactly `presetParams(preset, quoteWei, nowSec)`; otherwise `startOutWei = quote × (1 + N/10_000)` with `minOutWei` unchanged (quote × (1 − tolerance)), plus `expectedFillAfterSec ≈ duration × N / (N + toleranceBps)` (fair, N = 100 → ≈ 30 s). `MAX_START_PREMIUM_BPS = 1000`.

To expose it in `SwapForm.tsx` (UI session only):

```tsx
import { presetParamsWithPremium } from "@/app/lib/auction-start";

const [premiumBps, setPremiumBps] = useState(0);        // e.g. a "Start above market" toggle → 100
// line ~176, replacing presetParams(preset, startOut, nowSec):
const params = presetParamsWithPremium(preset, startOut, nowSec, premiumBps);
// and pass params.startOutWei (not startOut) as startOutWei to open_intent.
// The "you receive" range shows formatEth(params.startOutWei) → formatEth(params.minOutWei),
// and a hint: `Solvers should fill after ≈${params.expectedFillAfterSec}s`.
```

The existing OrderDrawer auction bar (`startOutWei` → `minOutWei` with `requiredOutWei` from `/api/payout`) then shows the decay live. CLI equivalent: `npm run cli -- trade --sol 0.01 --preset fair --start-premium-bps 100` prints `required_out` every second until a solver fills.

## Local CRE demo route

`POST /api/demo/cre-sign {"sigRequest": "<SigRequest or intent>"}` runs `cre workflow simulate soda-signer … --broadcast` on the local machine and returns `{exitCode, durationMs, userLogs, logTail, attribution}`. It returns 404 unless `DEMO_LOCAL_CRE=1`, so it is inert on Railway. A "Sign with Chainlink CRE" button can call it only when a `GET` to the same route answers 200.
