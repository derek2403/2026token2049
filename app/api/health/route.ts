// GET /api/health: Railway's healthcheck. No RPC calls, so it never trips a
// provider rate limit; it only says the server is up and has solvers configured.

import { connection as requestTime } from "next/server";

export async function GET() {
  await requestTime();
  const solvers = (process.env.SOLVER_URLS ?? "").split(",").filter((s) => s.trim()).length;
  return Response.json({ ok: true, solvers }, { headers: { "cache-control": "no-store" } });
}
