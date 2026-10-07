// The watcher's own Connection. web3.js retries a 429 up to four times by
// itself (500 ms to 4 s apart, console.error on each), so a rate limit reaches
// the caller as a slow success and the watcher's backoff never sees it. With
// disableRetryOnRateLimit the 429 is thrown at once and ProgramWatcher backs
// off (and logs it once per outage).

import { Connection } from "@solana/web3.js";

export function watcherConnection(rpcUrl: string): Connection {
  return new Connection(rpcUrl, { commitment: "confirmed", disableRetryOnRateLimit: true });
}
