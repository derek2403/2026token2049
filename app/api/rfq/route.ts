// POST /api/rfq: the RFQ relay (NEAR Message Bus style), JSON-RPC 2.0.
//   quote          {exact_amount_in, recipient?}                    → [{quote_hash, solver, amount_out, expiration_time}] best first
//   publish_intent {quote_hash, message, public_key, signature}      → {intent, tx}
//   get_status     {intent}                                         → {intent, status: PENDING | TX_BROADCASTED | SETTLED | NOT_FOUND_OR_NOT_VALID, ...}
// params may be an object or NEAR's one-element array. Logic: app/lib/server/rfq-relay.ts.

import { RpcError, getStatus, publishIntent, quote } from "@/app/lib/server/rfq-relay";
import { publicError } from "@/app/lib/server/solana";

type RpcId = string | number | null;

const reply = (id: RpcId, body: { result: unknown } | { error: { code: number; message: string; data?: unknown } }, status = 200) =>
  Response.json({ jsonrpc: "2.0", id, ...body }, { status, headers: { "cache-control": "no-store" } });

export async function POST(req: Request) {
  let id: RpcId = null;
  try {
    const raw = (await req.json().catch(() => null)) as { id?: unknown; method?: unknown; params?: unknown } | null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RpcError(-32700, "Body must be a JSON-RPC object", 400);
    id = typeof raw.id === "string" || typeof raw.id === "number" ? raw.id : null;
    const params = (Array.isArray(raw.params) ? raw.params[0] : raw.params) ?? {};
    if (typeof params !== "object" || params === null) throw new RpcError(-32602, "params must be an object", 400);
    const p = params as Record<string, unknown>;

    switch (raw.method) {
      case "quote":
        return reply(id, { result: await quote({ exact_amount_in: p.exact_amount_in, recipient: p.recipient }) });
      case "publish_intent":
        return reply(id, {
          result: await publishIntent({
            quote_hash: p.quote_hash,
            message: p.message,
            public_key: p.public_key,
            signature: p.signature,
          }),
        });
      case "get_status":
        return reply(id, { result: await getStatus({ intent: p.intent, intent_hash: p.intent_hash }) });
      default:
        throw new RpcError(-32601, `Unknown method ${JSON.stringify(raw.method)}: use quote, publish_intent or get_status`, 404);
    }
  } catch (e) {
    if (e instanceof RpcError) {
      return reply(id, { error: { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) } }, e.httpStatus);
    }
    return reply(id, { error: { code: -32603, message: `Relay error: ${publicError(e)}` } }, 500);
  }
}
