# SODA Signer: Chainlink CRE drives the MPC committee (devnet run log)

The committee pipeline used to be: soda's `SigRequested`, then an off-chain subscriber, then the MPC coordinator, then `finalize_signature`. In this run, Chainlink CRE ran that pipeline instead.

```
SigRequest (pending) ──▶ CRE workflow `soda-signer` (cre/soda-signer)
                          1. reads the SigRequest over Solana JSON-RPC (consensus: soda-owned, not completed)
                          2. POST coordinator /sign {sigRequestPubkey}: the 2-of-2 MPC nodes re-read the request
                             from chain and run Lindell 2PC ECDSA → {r, s, v} (consensus, shared cached response)
                          3. writes a 98-byte SignerReport through Chainlink's forwarder
                     ──▶ soda_cre_signer::on_report ──CPI──▶ soda::finalize_signature (secp256k1_recover check)
```

soda verifies the signature on-chain against the requester's derived key. A report through the mock forwarder therefore cannot forge a signature, so the simulation-only forwarder is not a trust gap for this path, unlike Witness.

| Item | Value |
|---|---|
| `soda_cre_signer` program | [`2cgtuK2Y9BQ8uMbVpYwM9FZ7TVkSqu9xegNTyBp3taxM`](https://explorer.solana.com/address/2cgtuK2Y9BQ8uMbVpYwM9FZ7TVkSqu9xegNTyBp3taxM?cluster=devnet) |
| Config `3pf5T3w2…` (mock forwarder) | [init_config](https://explorer.solana.com/tx/8D9ZpWpTnSRgdgVHsoqRwUKJVmSq6x17FXtsXxDRt91LJPaLnjTeuepxXWZyJNE5H2LUjexV1wLHP8vRRVy2vLW?cluster=devnet) |
| Submitter PDA (soda's `submitter` signer) | `DcsTQeE5YjVbeHiDuC3bgdguMGkMx9XV1gFaGUtCJFLo` |

## The run (2026-10-07 22:28–22:29 +08)

To show CRE doing the signing rather than racing it, the Railway `soda-mpc-subscriber` was stopped for 46 s (22:28:43 → 22:29:29), with the owner's approval, then redeployed. It came back subscribed with the same committee and `group_pk`.

| Step | Time | Link |
|---|---|---|
| RFQ trade: signed intent settled by solver A, SigRequest `FkTeqFX1…` left **pending** (no subscriber) | 1.7 s | [execute](https://explorer.solana.com/tx/5q2vr3xTiwo5w2Bsvmkq2LZNwdKopn2RtGBpnYAo3Y3m35RBCePtcxrSEzynbnEE4qm9uYeHfkWugC9xo7183iuz?cluster=devnet) |
| CRE read the SigRequest and got the MPC signature from the coordinator | 3 s | log: [`cre/runs/2026-10-07-broadcast-soda-signer.log`](../cre/runs/2026-10-07-broadcast-soda-signer.log) |
| CRE report → forwarder `Report` → `soda_cre_signer::OnReport` → `soda::FinalizeSignature` | 5 s | [tx](https://explorer.solana.com/tx/4y9mewnHMssvSWuVQzQMSXU4XA94owrLjTkWxx1rZBVe7tZ9FVoqCFp8RVvXsS4R38Di7L8FXFoZ59Gm7AhBJuvq?cluster=devnet) |
| Solver bot broadcast the committee-signed payout; 0.001079 ETH received on Base | | [Basescan](https://sepolia.basescan.org/tx/0xe09c7e26ffd8bcf2f82cd54c7a634d6b38b6d28eef9e860f0384003442250ced) |

Intent `EzMV5oZtA8qTJ29SKhAf6Bgxz9dKcQwgjgPSPHK8ub7d`. The trade took 26 s end to end, because the CRE simulator was started by hand after the fill. A deployed workflow would run on its own trigger.

Reproduce: `npx tsx scripts/cre-sign-payload.ts <intent>`, then `cd cre && cre workflow simulate soda-signer --target simulation-settings --non-interactive --trigger-index 0 --http-payload ./payloads/sign.json --broadcast`.

## /demo rehearsal: frontier's cross-chain signing demo, both signers (2026-10-07 23:16 +08)

These runs used `scripts/demo-rehearse.ts`: the page's own `runPipeline`, with a keypair standing in for Phantom, against a local build with `DEMO_LOCAL_CRE=1`. Each run sent 0.00001 ETH from the test wallet's SODA-derived Base address to itself, through `eth_demo::sign_eth_transfer` → soda `request_signature`.

| Run | Signer | Signing time | Total | Finalize | Base |
|---|---|---|---|---|---|
| Subscriber running | **SODA MPC subscriber** | 3.5 s | 6.2 s | [tx](https://explorer.solana.com/tx/4hx2sKWTNTqMKzgKWoiUmy2hmJw1Uj2ca8cy7sssfSm6FXUGhUhcpmGxJdFJZQ6prKv96E9tiBjq9eAjXXuQPVmz?cluster=devnet) | [Basescan](https://sepolia.basescan.org/tx/0x310b365dec3506ba3211ac06a8e7a3233e4cca79c936abc368cb8c736a460a7e) |
| `npm run demo:cre -- pause-subscriber`, then the page's "Run Chainlink CRE signer" route | **Chainlink CRE → SODA MPC** (forwarder `Report` → `soda_cre_signer::OnReport` → `soda::FinalizeSignature`) | 11.8 s, mostly the CRE simulator starting up | 15.0 s | [tx](https://explorer.solana.com/tx/3yhTZcCNigQnjDkupmqMJtdx9p75Sgi1RAjfuYhQhtNwCPWyAyW6TfqoiRa2JUKcZpbEi7PfctCuashRvMPLwP1F?cluster=devnet) | block 47808973 |

The subscriber was stopped at 23:16:59 and running again at 23:18:00 (`npm run demo:cre -- resume-subscriber`).
