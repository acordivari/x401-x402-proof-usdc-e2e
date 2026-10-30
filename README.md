# Agentic Payments Sandbox — x402 + Human-Identity Authorization

A working, testnet-only sandbox for **agent-initiated payments** over the
[x402 protocol](https://docs.cdp.coinbase.com/x402/welcome), with a research
layer that answers the question underneath agentic commerce: **which human
authorized this agent to spend, and within what scope?** Companies like Walmart, Tesla, and CVS are prioritizing infrastructure to expand agentic commerce. The sample flow below simulates the purchase of allergy medication from CVS. Funds for validation can be generated through [a faucet.](https://faucet.circle.com/)

> **No real funds, no real wallet.** Everything runs on **Base Sepolia testnet**
> against the free facilitator (`https://x402.org/facilitator`), funded with
> faucet test USDC. The agent signs with a headless **Coinbase CDP Server
> Wallet** (or a throwaway viem key) — your MetaMask is never connected.

## 🏁 Milestone — first live settlement (2026-06-20)

The agent completed its first **real, on-chain x402 payment** on Base Sepolia:
the agent received an HTTP `402`, signed an EIP-3009 USDC authorization, and the
live facilitator submitted the transfer — gasless for the agent. The order ledger
walked the full state machine `CREATED → QUOTED → AUTHORIZED → SETTLING → SETTLED`.

| | |
|---|---|
| **Item** | Allergy Relief 24-hr — **1.5 USDC** |
| **Tx** | [`0x7f23b8a5…43ab9e`](https://sepolia.basescan.org/tx/0x7f23b8a593d831fafd287389609f5655bbd1790dd199f78caeec38696243ab9e) |
| **From → To** | agent `0x57dfD786…092aB4` → merchant `0xCb6700f8…406bAe` |
| **Network** | Base Sepolia (`eip155:84532`), block `43124612` |
| **Path** | local viem signer + live `x402.org` facilitator (mandate enforcement off for this payment-rail run) |

Reproduce: `npm run setup:local` → fund the printed address → `npm run merchant`
+ `npm run agent allergy-relief-24`. _Next live milestone: the same settlement
gated by a signed Human Authorization Mandate._

## 🏁 Milestones — 2026-06-26 (identity authorization + hardening)

A push to make the "which human authorized this agent" layer real and
production-shaped. Every external boundary is a **swappable seam** (interface +
in-process/offline default + a real impl, injected), so productionizing is an
injection, not a rewrite. Suite grew to **153 tests / 24 files**.

1. **Three wallet workflows + official Proof SDKs** (`WALLET_FLOW`) — *self-issued*
   (browser-held SD-JWT-VC), *Proof-hosted* (real Proof wallet via
   `@proof.com/proof-vc-server` + the `<proof-verify-id>` web component from
   `@proof.com/proof-vc-web`), and *delegated*. The live verifier now pins Proof's
   committed trust store via the SDK.
2. **Delegated autonomous mandate** — the headline: a human presents **once** to
   sign a durable, scoped budget; the agent then buys **many** times over x402 with
   **no per-purchase approval** — the presigned identity is the standing
   authorization (`/api/agent/run`).
3. **Orchestrator security** — per-client **session isolation** + a shared
   access-token **gate** (fail-closed when exposed); autonomous spend restricted to
   the delegated flow; input validation; and a fail-closed `X401_ENCRYPTOR_KEY`
   guard. The demo server became an importable factory (`createDemoApp`) for HTTP
   end-to-end tests.
4. **Mandate revocation** — the issuer can kill a standing mandate early; the
   merchant then refuses any further spend against it. Two channels (`REVOCATION_MODE`):
   in-process registry, or an **HTTP issuer status endpoint** (OCSP-style),
   **fail-closed**.
5. **Durable + global spend-cap ledger** (`LEDGER_MODE`) — the `SpendLedger` seam:
   in-memory, **file-durable** (cap survives restart), or a central **HTTP service**
   so the cap is enforced **globally across merchants**, fail-closed. Plus a
   dependency-advisory fix (patched `ws` pinned via `overrides`).
6. **Persistent session store** (`SESSION_STORE`) — sessions (and any mandate they
   hold) survive a restart via a durable file store, behind a seam ready for an
   external store.

Decision recorded across the new channels: **fail-closed** — if the merchant can't
confirm a mandate's status or cap headroom, the spend is denied (safety over
availability). See [docs/ARCHITECTURE.md §8](docs/ARCHITECTURE.md) and
[docs/X401-PROTOCOL.md](docs/X401-PROTOCOL.md).

## 🏁 Milestone — first payment to an EXTERNAL x402 merchant (2026-07-02)

The new **live buyer** (`npm run live:discover` / `npm run live:buy`) found a
real third-party endpoint via the x402 Bazaar and paid it: **0.002 test USDC**
to `sandbox.node4all.com` on Base Sepolia
([tx `0xc4e2907b…5e24f2e`](https://sepolia.basescan.org/tx/0xc4e2907be1fb4fdee1f19c98aaebd8238bd1610cf2c415ea69dd473cd5e24f2e)) —
dry-run by default, testnet by default, per-call + durable-budget caps, and a
payee-pinned in-path `PaymentPolicy` so terms can't shift between preflight and
pay. Mainnet is one explicit `--mainnet --yes` away. See
**[docs/LIVE-BUY.md](docs/LIVE-BUY.md)**.

## Docs

- **[Aligning with Proof's October 2026 x401 stack](docs/PROOF-ALIGNMENT-2026-10.md)** —
  what Proof shipped, what the latest variant adopts, what's emulated, and what going
  live still needs.
- **[Going live on x401.thisisandrew.me](docs/GO-LIVE.md)** — the six-step runbook for the
  gated live verifier (second Render service, Cloudflare DNS, Proof enrollment).
- **[Live Buyer](docs/LIVE-BUY.md)** — discover + pay real x402 endpoints
  with wallet-side guardrails (the path out of the sandbox).
- **[Architecture & Decisions](docs/ARCHITECTURE.md)** — the product-owner's
  "what & why": problem, concepts, decision log, safety guarantees.
- **[HAM Protocol Spec](docs/HAM-PROTOCOL.md)** — the Human Authorization Mandate
  data model, verification rules, and threat model.
- **[x401 + Proof VC Authorization](docs/X401-PROTOCOL.md)** — combining x401
  identity proof with x402 payment, for both variants: the latest (merchant-verifier,
  signed DC API requests, Sign Transactions templates, Delegate Authority) and the
  July build (sealed-challenge binding, server-signed mandate).

## x401 wallet demo — who authorized this agentic payment?

```bash
npm run demo           # offline by default: build web + boot orchestrator
npm run demo:web       # in another shell for live-reload dev (Vite on :5173)
# then open http://localhost:4040
```

Requires **Node ≥ 22.12** (the Proof SDKs need it; `.nvmrc` pins 22). The page has
two variants, toggled from the strip at the top (`?variant=latest|july`, remembered
per browser):

### Latest (default) — Proof's October 2026 stack

The **merchant is the x401 verifier**. Its `/x401/buy/:sku` answers `401` with a
`PROOF-REQUEST` carrying a **signed DC API request** (`openid4vp-v1-signed`) with the
exact basket as a `payment-itemized:v1` term. The verifier's identity is a **Client ID
Metadata Document** it hosts at `/.well-known/proof-client.json`, so there's no OAuth app
or client secret. The agent hands the request to a wallet, exchanges the result for a
**Verification Token**, retries, gets `402`, pays over x402, and gets `200`.

- **Three wallet paths:** the demo wallet in the page, **Proof's Cloud Wallet** via an
  x401 handoff with a return channel (emulated offline), or the browser's Digital
  Credentials API (`navigator.credentials.get`).
- **x402-paid presentations:** presentations arrive with their signatures detached,
  and the merchant buys them back from (emulated) Proof over x402 before it can verify.
- **Standing mandates as Delegate Authority:** the person's **credential key** signs
  a mandate naming the agent's key. The terms are Proof's `payment_mandate_v1`, and
  the merchant enforces the budget, scope, expiry and revocation itself.

### July 2026 — preserved as shipped

The original UI and flows: self-issued, Proof-hosted (redirect + paste-back,
`<proof-verify-id>`), and the delegated mandate signed by our Authorization Service.
They run unchanged on the current SDKs.

```bash
# the July autonomous (delegated-mandate) flow, fully offline:
WALLET_FLOW=delegated PROOF_MODE=local FACILITATOR_MODE=mock npm run demo   # then pick "July 2026"
```

## Why TypeScript

The entire official x402 v2 stack (`@x402/express`, `@x402/evm`, `@x402/fetch`,
the facilitator, AgentKit, the reference agents) is TypeScript-first. This repo
targets the **`@x402/*` v2 packages (2.16.x)**.

## Architecture

A DRY npm-workspaces monorepo. The shared core is defined once and imported by
every package, so payment shapes, validation, and the order state machine can
never drift between agent and merchant.

```
packages/
  shared/     # DRY core: constants, money math, Zod wire schemas (x402 v2),
              # order state machine, mandate (HAM) model + scope validators,
              # payment-parameter validators, Signer interface
  merchant/   # "mock-CVS" storefront (seller)
              #   order-store     — state-machine-guarded order ledger + idempotency
              #   facilitator/    — FacilitatorClient seam:
              #       mock.ts      — offline facilitator (synthetic settlement)
              #       resilient.ts — retry + per-nonce idempotency + transaction lock
  agent/      # headless buyer agent (CDP Server Wallet -> x402 client)
  identity/   # OIDC verifier (local + Auth0) + HAM signing/verification
  credentials/# x401 + Proof verifiable-credentials seam:
              #   SD-JWT-VC issue/hold/present (selective disclosure) + DCQL,
              #   transaction_data payment binding, VerifiableCredentialVerifier
              #   (local | proof), and @proof.com/x401-node wire wrappers
apps/
  wallet-demo/# Vite + Svelte x401 wallet demo (VC presentation -> HAM -> x402)
```

(The original no-build OIDC demo console, `apps/console`, was retired in favor
of the wallet demo — same flow plus x401 identity, session isolation, and the
auth gate. It lives in git history.)

### Safety guarantees (validated by tests)

- **Payment-parameter validation** — independent defense-in-depth on the signed
  EIP-3009 authorization (asset allowlist, exact amount, recipient, time window).
- **Order state machine** — `CREATED → QUOTED → AUTHORIZED → SETTLING → SETTLED
  → REFUNDED` (plus `FAILED`/`EXPIRED`); illegal transitions throw, so state can
  never corrupt.
- **Settlement resilience** (`ResilientFacilitatorClient`, the single settlement
  seam): transient failures retry with backoff; **terminal failures never
  retry**; settlement is **idempotent per EIP-3009 nonce** and **lock-coalesced**
  so a retry storm can't double-charge.

### Human Authorization Mandate (HAM)

The protocol contribution, modeled on Google AP2's Intent → Cart → Payment
mandate chain but with the authorizing human's **identity bound into the
Intent**. Scope checks prove `Payment ⊆ Cart ⊆ Intent` (spend cap, merchant
allowlist, item categories, expiry). See `packages/shared/src/mandates.ts`.

### x401 identity authorization — verifiable credentials + DCQL

The newest layer answers *who authorized this* with a **verifiable credential**
instead of just an OIDC login. It combines the **x401** identity-proof protocol
with x402 payment so a verified human, in a **single credential presentation**,
both **selectively discloses** identity (driven by a **DCQL** query) **and**
**authorizes the specific payment** (Proof's `transaction_data` / `payment-mandate`).
The disclosed identity becomes the HAM principal; the merchant's x402 paywall and
settlement are unchanged.

- **New seam** (`packages/credentials`): a `VerifiableCredentialVerifier` with two
  implementations behind one interface — `localVcVerifier` (self-issued SD-JWT-VC,
  offline/CI) and `proofSdkVcVerifier` (live Proof via the official
  `@proof.com/proof-vc-server` SDK, pinned to Proof's committed trust store).
  Mirrors the facilitator/identity seams; selected by `PROOF_MODE`.
- **Three wallet workflows** (`WALLET_FLOW`): self-issued, Proof-hosted (SDK +
  `<proof-verify-id>` web component), and **delegated** — a presigned, durable,
  scoped mandate the agent spends autonomously with no per-purchase approval.
- **Selective disclosure (DCQL):** credentials are SD-JWT-VC; the verifier names the
  claims it wants and the wallet reveals only those — e.g. disclose `age_over_21`
  without revealing `birth_date`.
- **Payment binding (the 401↔402 join):** the agent's payment is sealed into the
  x401 challenge, and (live) Proof binds the `payment-mandate` inside the
  holder-signed key-binding JWT — cryptographic proof the human approved *this*
  payment, not just "some payment".
- **Issuer trust:** Proof signs with an ES256 **x5c** certificate chain; the live SDK
  verifier pins it to Proof's committed trust store, selected by environment since
  proof-vc-server 0.5 (`sandbox` → the development root, `production` → Proof Root CA R1).

Flow: `PROOF-REQUEST (DCQL + payment) → wallet presentation (vp_token) → verify
(credential + holder + nonce + payment) → signed HAM Intent → x402 settlement`. The
identity source for HAM thus becomes swappable: **OIDC → Intent** *or*
**VC presentation → Intent**, with the payment-rail unchanged. See the
[x401 protocol notes](docs/X401-PROTOCOL.md) and run `npm run demo`.

## Develop

```bash
npm install
npm test          # vitest — 290+ tests across shared, merchant, identity, credentials, agent, both demo variants
npm run typecheck # tsc --noEmit, strict
```

## Live Base Sepolia path

All free; testnet only. The offline demo/tests need none of this
(`FACILITATOR_MODE=mock`).

1. **CDP API key** — create at the Coinbase Developer Platform portal, put
   `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET` in `.env`.
2. **Set up wallets + faucet** (turnkey):
   ```bash
   npm run setup:live
   ```
   Creates the agent + merchant CDP Server Wallets, pulls testnet USDC from the
   CDP faucet, and prints the `MERCHANT_PAY_TO` + the exact run commands. (No ETH
   needed — settlement is gasless EIP-3009; the facilitator submits.)
3. **Run live:** `FACILITATOR_MODE=http WALLET_MODE=cdp` for the merchant +
   agent, as printed by the setup script. Track wallets on
   `https://sepolia.basescan.org`.
