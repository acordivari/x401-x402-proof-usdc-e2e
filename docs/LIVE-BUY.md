# Live Buyer — paying real x402 endpoints

The sandbox proves the rails against our own merchant; the **live buyer**
points the same agent stack at the open x402 ecosystem: discover a real
paid resource, preflight its 402 challenge, and settle a real (test or
main-net) USDC payment — with hard, wallet-side guardrails.

Status: **working**. First external settlement 2026-07-02 — `0.002` test USDC
to `sandbox.node4all.com/v1/x402-test` on Base Sepolia
([tx `0xc4e2907b…5e24f2e`](https://sepolia.basescan.org/tx/0xc4e2907be1fb4fdee1f19c98aaebd8238bd1610cf2c415ea69dd473cd5e24f2e)),
discovered via the Bazaar, gasless for the agent (facilitator submitted).

## Commands

```bash
# 1. Find something to buy (Bazaar index; read-only, no key needed)
npm run live:discover                                # Base Sepolia listings
npm run live:discover -- --mainnet --max 0.02 --query news

# 2. Preflight (default = DRY RUN: decodes the 402, checks every guard, pays nothing)
npm run live:buy -- https://sandbox.node4all.com/v1/x402-test

# 3. Pay (testnet)
npm run live:buy -- https://sandbox.node4all.com/v1/x402-test --yes

# 4. Pay (REAL FUNDS — explicit opt-in, tight caps)
npm run live:buy -- https://x402.ottoai.services/crypto-news \
  --mainnet --max 0.01 --budget 0.25 --yes
```

Flags: `--max` per-call price cap (default `0.05` USDC) · `--budget` durable
cumulative cap (default `1.00`) · `--method`/`--body` for POST endpoints ·
`--journal` spend-journal path (default `.live-spend.json`, gitignored) ·
`--mainnet` to leave the testnet default · `--yes` to actually pay.

Wallet: `WALLET_MODE=local` + `AGENT_PRIVATE_KEY` (from `npm run setup:local`,
fund at [faucet.circle.com](https://faucet.circle.com) for testnet) or
`WALLET_MODE=cdp` with CDP keys. `BASE_RPC_URL` overrides the public RPC.

## Guardrails (all fail-closed)

Real x402 payments are **irreversible push payments** — the 402 response names
a `payTo` and the client signs money to it. So authorization lives entirely on
our side, in two layers that share one rule set (`live/guard.ts`):

1. **Preflight** (`evaluateQuote`) — decode the challenge without paying and
   show a verdict per offered option: `exact` scheme only, the one selected
   network only, that network's canonical USDC only, price ≤ `--max`,
   recipient allowlist.
2. **In-path policy** (`createSpendGuardPolicy`) — the same rules injected
   into the x402 client as a `PaymentPolicy`, with the recipient **pinned to
   the preflighted `payTo`**. If the server's terms shift between look and
   pay (price bump, payee swap, network change), every option is filtered out
   and the client refuses to sign. No time-of-check/time-of-use gap.

Plus, before anything signs:

- **Durable budget** — `LiveSpendJournal` (file, atomic writes) records every
  attempt *before* signing (reserve → paid/failed). Reservations count toward
  the budget, so a crash mid-payment over-counts and can never over-spend —
  the wallet-side mirror of the merchant `SpendLedger`. A corrupt journal is a
  hard error, not an empty start.
- **Balance check** — on-chain USDC read; refuses (when executing) if the
  wallet can't cover the price.
- **Testnet by default, dry-run by default** — real funds require both
  `--mainnet` and `--yes`.
- **Ambiguous failures stay reserved** — if the paying fetch throws after
  signing may have happened, the reservation is left standing and the CLI says
  to verify on-chain before retrying (the EIP-3009 nonce is the idempotency
  key).

## How it maps onto the existing seams

| Piece | Reuses |
|---|---|
| Signing | `PaymentSigner` seam (`createLocalSigner` / `createCdpSigner`) |
| Paying | `createPayingFetch` — now takes `network` + `policies` (existing callers unchanged) |
| Networks | new `packages/shared/src/networks.ts` registry (`BASE_SEPOLIA`, `BASE_MAINNET`); `constants.ts` derives the sandbox defaults from it |
| Quote shape | new `ExternalPaymentRequirements` in `shared/schemas.ts` (relaxed scheme/network; the guard, not the schema, decides acceptability) |
| Balance read | injected (`readBalance`) so the full flow runs offline in `test/e2e-live-buy.test.ts` against the mock-facilitator merchant |

The mandate/HAM layer is intentionally **not** wired in yet: the guard is the
minimal wallet-side authorization. The natural next step is issuing a real
delegated `IntentMandate` whose scope feeds `SpendGuardConfig`, so the same
signed human authorization that gates our merchant also bounds open-web spend.

## Ecosystem notes (verified 2026-07-02)

- **Facilitator hosts:** bare `x402.org` now 302s to a Linux Foundation
  placeholder; the API answers on `https://www.x402.org/facilitator`
  (`DEFAULT_FACILITATOR_URL` updated). The CDP facilitator
  (`api.cdp.coinbase.com/platform/v2/x402`) settles mainnet: 1,000 tx/month
  free then $0.001/tx, gas sponsored, KYT/OFAC screening per tx.
- **Discovery:** the Bazaar (`…/v2/x402/discovery/resources`, no key for
  reads) indexed ~23k resources; mostly Base mainnet, a handful of Base
  Sepolia test endpoints.
- **Cheap real endpoints:** `x402.ottoai.services/*` ($0.001),
  CoinGecko `/api/v3/x402/…` ($0.01, no API key), Exa search ($0.007),
  Tavily search ($0.01).
- **Physical goods** (the "buy something IRL" stretch): the two self-serve
  rails for an individual dev are **Crossmint Worldstore** (headless Orders
  API: ASIN/Shopify product + shipping address, pay USDC, Crossmint is
  merchant-of-record) and **Stripe Link for agents** (`@stripe/link-cli`,
  scoped one-time card, human approves each purchase in the Link app).
  Shopify's Catalog/Checkout MCPs work keyless but end in a human-handoff
  `continue_url` at checkout for untrusted tiers. Amazon/Perplexity remain
  closed. Google AP2 runs only against sample merchants.
