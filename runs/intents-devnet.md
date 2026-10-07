# SODA Intents: devnet run log

## Deployment (2026-10-07)

| Item | Value |
|---|---|
| intents program | [`BV9KfzKwXPp9hQZEyhoVm9STbDy7gCGCmKcKpCDr8jXA`](https://explorer.solana.com/address/BV9KfzKwXPp9hQZEyhoVm9STbDy7gCGCmKcKpCDr8jXA?cluster=devnet) |
| upgrade authority / admin | `57Y6siThZ6JUjjpgQ7JT7JUFVk4e1xcAsCDRHJBQUXkE` |
| Pool PDA (SODA requester) | `WtaezksvpBC1LGh4oV7xvURsdtdTv752z1A4NpLv7uS` |
| Pool Base Sepolia address | [`0x7662920f66682D8996EC6B6D9E4ac9ed25a1006C`](https://sepolia.basescan.org/address/0x7662920f66682D8996EC6B6D9E4ac9ed25a1006C) |
| init_config | [tx](https://explorer.solana.com/tx/2YXJn7AQ821rBLDSExzZyZbcGGubr697BgXYvW9JTw8wBsjb1e1AAE9KjvveLL1Bv4yUYUThabFZJKMeyo3fE8yu?cluster=devnet) |
| register_solver (`D5pw…`) | [tx](https://explorer.solana.com/tx/2LCVS77Ms83K3oTKGLaQPDr29JwKSDa2n7LsEjyrFartCZEZtmjdB73r9tZwpLjsLvxbCKcjHvqYEnkdkVvHVi2E?cluster=devnet) |
| solver deposit, 1 ETH to the pool | [Basescan](https://sepolia.basescan.org/tx/0xb9d12a5ab63a10f508a1288e0fa6db38da7a46b50d25daf06125669aec2757d7) |
| credit_solver, 1 ETH | [tx](https://explorer.solana.com/tx/5ccqjTNFFnfYqPkGJk5AA1XCrpn8EocmCMnD4F7sookjfH8hmmiC7JVn9mzH3r8kZFhRjoXmhsf9kjcTAxjZTRvP?cluster=devnet) |

## First trade: 0.05 SOL to native ETH on Base, Fast preset

- User `JD83fBc825nQn4PAtMFhyrnME41PkrnCXtA6cXin7GX2`; recipient is the user's own SODA-derived Base address, `0xDD8E4c6a974D8a9F1E1e2499878A6C0d7213FaD7`.
- Intent `Ho7XxPrfH4BFZNwsoFCf3DZXLX1tR72wqyDw221hrRwd`.

| Step | Time (cumulative) | Link |
|---|---|---|
| open_intent confirmed | 2.3 s | [tx](https://explorer.solana.com/tx/2nyFxscjyCNnKMeRmgKLazRQ9dvuy9Nw3FqTxj9CTkGy47foEiXJxBVdCbnKf6c9FKusMDyMdgXamSuRxxtZaphE?cluster=devnet) |
| solver fill (SOL to the solver, SODA signature requested) | 13.8 s | [tx](https://explorer.solana.com/tx/2FU8v9fFPCQcu2ibg3G8R2SSWbx9Z7ur4HwNQfyvTrvrUPc7xV3fcWGcrVT7QHy8FZueYNJ947zirSw5QcVqR6Db?cluster=devnet) |
| committee signed; soda verified it with secp256k1_recover | 15.6 s | SigRequest [`GXRGBBc7…`](https://explorer.solana.com/account/GXRGBBc7EdDAE5qnH2AxV6PzJ42KjVRiBLHkawY1FjUC?cluster=devnet) |
| 0.002138 ETH received on Base (nonce 0, block 47800366) | 15.6 s | [Basescan](https://sepolia.basescan.org/tx/0x353d5150b40bdf90042905b7eb76a8f51feb6a77204f6e52f8f3096750159609) |

Most of the 13.8 s before the fill is the bot's fallback poll. The public devnet WebSocket was rate-limited at the time, so the bot found the intent through its 10 s getProgramAccounts poll.

## Independent audit (frontier `pnpm verify`)

```
VERIFY_REQUESTER=WtaezksvpBC1LGh4oV7xvURsdtdTv752z1A4NpLv7uS DEMO_CHAIN=base-sepolia pnpm verify 0x353d5150…9609
✓ v decodes to Base Sepolia chainId 84532: MATCH
✓ PDA exists for the payload Sepolia signed: MATCH  (SigRequest.payload == keccak(unsigned RLP))
✓ SigRequest is completed: MATCH
✓ On-chain recovery_id matches v's parity: MATCH
✓ Solana SigRequest.signature == Sepolia tx (r,s): MATCH
✓ recovered_pk == SigRequest.foreign_pk_xy: MATCH
✓ derived ETH address == tx.from: MATCH  (no private key for this address exists anywhere — only Solana program control)
✓ derived foreign_pk == on-chain SigRequest.foreign_pk_xy: MATCH
```

## Two solvers racing (both at 30 bps)

Solver A is `D5pw…`. Solver B is `CozgNEdiG93qqo8cxXeXddvuT3F1Gh6zHr4VLro1sZ54`: [register](https://explorer.solana.com/tx/3DHXc9ehZXhv2c5e2tugjz2hdSpxC71BhUUTppNtUjdAtE3qS1AXAjYoWh7SUs5ZH485WRMzmLhK86E7zptJRqdv?cluster=devnet), [0.5 ETH deposit](https://sepolia.basescan.org/tx/0xaa9bf7dc09866e2a3b8ef5db3ab30bbbbe8f490dcb5ca3e317deb8615262623d), [credit](https://explorer.solana.com/tx/nkabK7KQt9ravLo32Z2tHg2miFs8SRPtfGAgsiKuj8YFfcYL9Z7ca2BcmXuipyZr9v9RXw6ekGGnJTPXtvZjAdo?cluster=devnet).

Both bots subscribe to `logsSubscribe` on OnFinality's public WebSocket. Both quoted 0.002141 ETH for the intent.

- Intent `FxXuGJTEYkYd1xhGPAeCuf6rDXxGDx46RRn9AcPeBNPH`, 0.05 SOL. It was opened, filled by A 3.2 s after opening ([fill](https://explorer.solana.com/tx/3hCi6rDPgEUub9wPzXo9bEYBCm42aStfSEKxnCZiAkk4akgFrXBeoMhW1KN5td6cntKeoHKEYjxbEjVkp61MsvHk?cluster=devnet), nonce 2), and paid on Base, **6.4 s end to end**.
- B's fill on the same intent was rejected on-chain with `IntentNotOpen` (6001): [tx](https://explorer.solana.com/tx/3d6ARGnfbv5gMxD5sj5w3AduHT1v9aEQKjHjNmdrPkjssTy69juDw6Qdc9C9i6LMuiXyzpUyj4GN7caZ4EWQQA95?cluster=devnet). Reproduce with `npx tsx scripts/demo-rejected-fill.ts <intent> --keypair <solver B>`.
- An earlier trade, before the WebSocket switch: intent `8z9P3Y6fHq4nJnUvCBd6Et68HNQCjEUUfCNpzgKT3fUq`, nonce 1, [payout](https://sepolia.basescan.org/tx/0x6b8823e6eb1e72e8588d285570e1ebb21e50e62a13bb570eb0c93d368b912db4).

## Cancel and close

The user's maker cancel works before any fill. To keep solvers away, this intent asks for an unfillable amount: 0.01 SOL for at least 10 ETH. Intent `DhbreGbaSqfiLw25eQNvLNCRAYg6FbasGKjAVkQwfYss`.

| Step | User balance | Link |
|---|---|---|
| open_intent (0.01 SOL escrowed, plus rent) | 0.03065 SOL after | [tx](https://explorer.solana.com/tx/WBzzmxyZ3vX4EVPdChSz694tVMNspcFZoZmGjBYReDpRrPLy6zvvaq3kqTaGvFd3UkaQRUXLK9xBuZfayNysd5R?cluster=devnet) |
| cancel_intent (escrow refunded) | 0.04065 SOL (+0.01) | [tx](https://explorer.solana.com/tx/3NJWwZ2sURK4NPZod17h9HGK9rm1ZjukbQ9fdU9CohgdYFL9jPhkoAywMKQAHkD3LwHfyVTcC7ofNK7bLhFfF7e5?cluster=devnet) |
| close_intent (rent returned) | 0.04297 SOL (+0.00233) | [tx](https://explorer.solana.com/tx/2vGhUvn4d7hL3fg32DEpJMkeTouKpB6uR7qao5eqnnQoP67zBAVr3EfpHGHS7FpLoqQgQ2u2kMGPKtmCNzUcgxnm?cluster=devnet) |

## Hosted on Railway

The page is at https://web-production-734ea.up.railway.app. `solver-a` (30 bps) and `solver-b` (60 bps) run as private services in the same Railway project. The page's `/api/quotes` reaches them over Railway's private network. The bots find intents by polling `getSignaturesForAddress` on the program through Alchemy, with no WebSocket and no `getProgramAccounts`.

- Intent `Eb3vsCjSvE3cAqc9A1QcgdZUZjCGt998AF23mr2dXHP2`, 0.05 SOL, Fast preset, filled by the Railway `solver-a` ([fill](https://explorer.solana.com/tx/3c1QGQWuZqP9gSzwu53EYJncXBUkuQKx9NvJvAnDwFaA3smvc57PRYvhjZtCSvdunSJUmcikx2ZVM11GaCBKm5gZ?cluster=devnet)). 0.002139 ETH reached Base ([Basescan](https://sepolia.basescan.org/tx/0xc5ea174bd5f6aa6f2c7056a1b079f1b9a4721a8f516067246a44a35b3ed6a325)): **5.9 s end to end**, of which open_intent took 1.5 s.
