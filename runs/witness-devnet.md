# SODA Witness: devnet run log

## Deployment (2026-10-07)

| Item | Value |
|---|---|
| soda_witness program | [`5v97wLYgMzyfQfpZWGQ6uPXTHh4JsJitUXPReYy2uuTp`](https://explorer.solana.com/address/5v97wLYgMzyfQfpZWGQ6uPXTHh4JsJitUXPReYy2uuTp?cluster=devnet) |
| Config PDA | [`5Dxc9Y6sWUwvcLUhatWAHmBwVnKfUXPu5cuWccZZCNRY`](https://explorer.solana.com/address/5Dxc9Y6sWUwvcLUhatWAHmBwVnKfUXPu5cuWccZZCNRY?cluster=devnet): admin `57Y6…`, the Chainlink **mock** forwarder `7kuEAA3m…` / state `5Tipz3yh…`, workflow owner and name checks off |
| init_config | [tx](https://explorer.solana.com/tx/63bZGEKbqK4BfygCdof6HFa8W7QuViYvGbvw8759oFLD1F1b33f8mK9JF5b89L6dm7FiGZPnmZvtW7Z679z8fBCX?cluster=devnet) |

## Claim: the intents solver deposit (1 ETH from the BOT wallet to the pool on Base Sepolia)

1. `open_claim(84532, 0xb9d12a5a…757d7)` by requester `D5pw…`: claim [`2LHehzzCpXXMHpWhDMZRTCsZGXTsF5kzSVJDXfjGoEmF`](https://explorer.solana.com/address/2LHehzzCpXXMHpWhDMZRTCsZGXTsF5kzSVJDXfjGoEmF?cluster=devnet), Pending, [tx](https://explorer.solana.com/tx/3VKKmCEefgmihjfwAkC4dr9C3RM9e9qeQ2pnS84n23eFA4N7oQ4Mgim3tFZNb8kb4ePEAVVBatLwNfQvoZ1THnt8?cluster=devnet).
2. `cre workflow simulate soda-witness … --broadcast`: the workflow read the receipt and the tx (identical consensus) and the head (median consensus) from Base Sepolia, and required at least 3 confirmations (there were 899). It then wrote the 106-byte WitnessReport through the mock forwarder: [on_report tx](https://explorer.solana.com/tx/23541hZLtRNbaJyrrZgDT4ExxMgJyUYeeetUdZF2x51Z5ZqiJcZgV4HFf4saUYsNyBJdZt2JXyLRkH1arfG81b2u?cluster=devnet). The full log is [`cre/runs/2026-10-07-broadcast-deposit-claim.log`](../cre/runs/2026-10-07-broadcast-deposit-claim.log).
3. The claim is now **Recorded**:

```
Claim 2LHehzzCpXXMHpWhDMZRTCsZGXTsF5kzSVJDXfjGoEmF  Recorded
  chain_id     84532
  tx_hash      0xb9d12a5ab63a10f508a1288e0fa6db38da7a46b50d25daf06125669aec2757d7
  success      true
  from         0x31777694f7b90b635b1f3b786f5d24be7651be7b
  to           0x7662920f66682d8996ec6b6d9e4ac9ed25a1006c   (the intents pool)
  value_wei    1000000000000000000
  block        47799710
```

The forwarder metadata logged by `on_report` was `1111…1111 | 32643363366634626264 | aaaa…aaaa | 0001`, that is, cid | name | owner | report id. In simulation the workflow owner is a placeholder (`0xaaaa…`).

## Trust caveat

`cre workflow simulate` always writes through Chainlink's mock forwarder. The mock forwarder checks no DON signatures and has no replay protection, and anyone can call it. Under simulation, a Recorded claim proves the report was well formed, not that a DON produced it. A deployed workflow plus the production forwarder (`CXsKEJcs…`, which checks f+1 DON signatures) closes this gap. Chainlink confirmed that simulation is acceptable for this hackathon. The claim itself can be recorded only once, because `on_report` requires the claim to be Pending.

## Phase 2: a solver deposit credited from a Witness claim (links both builds)

This is the intents `credit_solver_from_claim` instruction. It reads the soda_witness Claim account and checks the facts itself: owner is the witness program, Recorded with success, chain 84532, `to` is the pool, `from` is the solver's `deposit_from`, and the requester is the solver. A `["credit", tx_hash]` record makes each Base deposit creditable once, whether by claim or by admin. While the witness runs on the mock forwarder, the admin must co-sign (`UntrustedWitness` otherwise). The instruction becomes permissionless once the witness is on the production forwarder with a pinned workflow owner.

Rollout of the upgraded program:

| Step | Link |
|---|---|
| set_paused true | [tx](https://explorer.solana.com/tx/3MeX31aYmHxMgyjUapS99yXnjDx6wzAxfbmgQKeudV9cdRNMVE8UxAmR5uu1LDwUXu2sP8YJca4rziPjzVT8fm8U?cluster=devnet) |
| Extend and upgrade intents (sha256 `f8836b39…`), IDL upgraded | |
| Backfill Credit records for the two admin-credited deposits | [A](https://explorer.solana.com/tx/3k9RKVTaGUh3vSYJZf49bCMYq1Bdttf7HHU3L6RfHsRegNsLiEWKwFFGJyKQDTPpKZNc8PJsLY1FapJZB7y1Lu2E?cluster=devnet), [B](https://explorer.solana.com/tx/fc23B3ErMQxG93bW8VrM9GfQni25nNGzcwXwXtM4Yx7LGcn98Azk1C5hS7LLeagGccduV1voDsYYnc2xw4RpLxr?cluster=devnet) |
| set_paused false | [tx](https://explorer.solana.com/tx/Xr7b6JRr9nZd5mDEnvgyVhufDo258tHW7xhKxKArpC1Z9XWBbYVQw8GEmwWjb3yHB9HXip4jnqWm6WqdrLJqZkQ?cluster=devnet) |

The run:

| Step | Link |
|---|---|
| Solver A's operator deposits 0.1 ETH to the pool on Base (block 47801952) | [Basescan](https://sepolia.basescan.org/tx/0xb3997391723ebddc8b0514b4604e5dbff942115dd952d041cba4e14753c5c08c) |
| `open_claim`, signed by solver A (`D5pw…`): claim `FwFutiPUmmfaMHq6xBcm7quLXi2qbpfhfg1egiMm6AsW` | [tx](https://explorer.solana.com/tx/2wmiRtdXrw5kVq5SV7Ru35LigkEfy7vXMDbw1V9Bs4prWNPwd3rPhTvrtULWKJ1PjYAbvsxXoKQbWsSSMikfCtxi?cluster=devnet) |
| CRE `simulate --broadcast` (11 confirmations), then `on_report`: claim Recorded | [tx](https://explorer.solana.com/tx/5ZqG2ZMLemTMAqBT3ZnMqvMCCpJoZCpNhxsUU9E37kxDXHjZUWorv944EXd27mq5YkdsU7cYL7CoD24kPKCGTGxN?cluster=devnet), [log](../cre/runs/2026-10-07-broadcast-phase2-claim.log) |
| `credit_solver_from_claim`: solver A's ledger goes from 0.993515 to **1.093515 ETH** | [tx](https://explorer.solana.com/tx/CrGcrniDaRMessATxk81gYqJh83rrZYusgdudCoxEh61hguv9gzgXXBj86iGuBwcvpwDv8h5RQKmE2uJCfuEBBU?cluster=devnet) |
| Second attempt on the same deposit: refused, with "deposit already credited" (Credit `E99UAwAs…`) | |

SODA signs authority out to Base; Witness brings the deposit fact back in. No admin decides the amount; the admin's co-signature only stands in for the DON signatures the mock forwarder lacks.
