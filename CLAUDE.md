# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A testnet-only sandbox for agent-initiated payments over the x402 protocol, plus the research
contribution: the **Human Authorization Mandate (HAM)** layer answering "which human authorized
this agent to spend, and within what scope?". TypeScript ESM, npm-workspaces monorepo, **Node >= 22.12**
(the Proof SDKs require it; `.nvmrc` pins 22).
No build step for packages — everything runs from source via `tsx`; only the wallet-demo web UI
builds (Vite). There is no linter; `npm run typecheck` (strict tsc) is the static gate.

## Commands

- `npm test` — vitest, whole repo (unit tests in `packages/*/test`, cross-package HTTP e2e in root `test/`)
- Single test file: `npx vitest run test/e2e-mandate.test.ts` · by name: `npx vitest run -t "substring"`
- `npm run typecheck` — tsc --noEmit over `packages/*/src` + `apps/wallet-demo/server`
- `npm run demo` — build web UI + boot the orchestrator (http://localhost:4040), fully offline by default
- `npm run demo:web` — Vite dev server (:5173) for live-reload UI work, alongside `demo:server`
- `npm run merchant` / `npm run agent <sku>` — standalone mock-CVS storefront + headless buyer
- `npm run setup:local` | `setup:live` — mint wallets (throwaway viem key | CDP Server Wallets + faucet)
- `npm run live:discover` / `live:grant` / `live:buy -- <url>` — the live external-merchant path (see below)
- `npm run check:x401` — x401 spec/SDK drift check against `x401-spec.lock.json`

Tests and the demo need **no keys or network**: mock/local implementations are the default for every seam.

## Architecture

Read `docs/ARCHITECTURE.md` for the what/why; `docs/HAM-PROTOCOL.md` and `docs/X401-PROTOCOL.md` for specs;
`docs/PROOF-ALIGNMENT-2026-10.md` for what Proof shipped in Oct 2026 and what is live vs emulated;
`docs/UCP-HANDLER.md` for the UCP-shaped `payment_handler` responder/client (opt-in, `UCP_MERCHANT_ENABLED`).

### Workspace layout

- `packages/shared` — the DRY core imported by everyone: Zod wire schemas (x402 v2), money math,
  order state machine, HAM mandate model + scope validators, `ValidationResult`, `PaymentSigner`
  interface, clock helpers. Never redefine these locally.
- `packages/merchant` — seller: catalog, state-machine-guarded `order-store`, `mandate-gate`,
  `spend-ledger`, the facilitator seam (`facilitator/mock.ts`, `facilitator/resilient.ts`), and an
  opt-in UCP-shaped checkout responder (`ucp/profile.ts`, `ucp/checkout-routes.ts` — see `docs/UCP-HANDLER.md`).
- `packages/agent` — headless buyer (`buyer.ts`, `x402-client.ts`, `wallet.ts`) + `src/live/` buyer,
  including a `UcpCheckoutClient` (`src/live/ucp-checkout.ts`) for the UCP-shaped responder above.
- `packages/identity` — OIDC verifier (local | Auth0), HAM signing/verification, revocation checkers.
- `packages/credentials` — x401 verifiable-credentials seam. July modules: SD-JWT-VC
  issue/hold/present, DCQL, sealed-challenge `transaction_data` binding, local vs Proof-SDK
  verifiers. Latest (`*-v1.ts`, `x401-verifier-v1.ts`, `x401-agent-v1.ts`): `ProofCredentialV1` +
  fixed scopes, Sign Transactions templates, signed DC API requests, CIMD, nonce store, detached
  x402-paid signatures, Delegate Authority (`delegation.ts`), and the shared demo wallet
  (`demo-wallet.ts`, browser-safe via `./browser`).
- `apps/wallet-demo` — Vite+Svelte UI with two variants behind a toggle (`src/App.svelte` shell:
  `variants/latest/` default, `variants/july/` frozen as shipped) + the Express orchestrator
  (`server/`, exported as `createDemoApp`; the latest variant's routes are in `server/latest/`,
  including the offline Proof emulator).

### The two-protocol flow (payment x authorization)

1. **x402 payment rail**: agent requests a resource → merchant replies HTTP 402 with payment terms →
   agent signs an EIP-3009 USDC authorization → facilitator verifies/settles (gasless for the agent).
   The merchant's order ledger walks `CREATED → QUOTED → AUTHORIZED → SETTLING → SETTLED` (plus
   FAILED/EXPIRED/REFUNDED); illegal transitions throw.
2. **HAM authorization layer**: a verified human (OIDC login *or* an x401 SD-JWT-VC presentation with
   the payment sealed into the challenge) yields a signed **Intent mandate** (budget cap, merchant
   allowlist, categories, expiry). Merchant-side `mandate-gate` proves `Payment ⊆ Cart ⊆ Intent`,
   the `SpendLedger` enforces the cumulative cap, and `RevocationChecker` lets the issuer kill a
   standing mandate. Three wallet workflows (`WALLET_FLOW`): self-issued, proof-hosted, and
   **delegated** — the human presents once, the agent then spends autonomously under the mandate.
   This is the **July** variant's model (orchestrator = verifier, server-signed Intent).
3. **Latest variant** (`/x401/buy/:sku`, `packages/merchant/src/x401/gate.ts`): the **merchant is the
   x401 verifier**. `401 PROOF-REQUEST` (signed `openid4vp-v1-signed` request, CIMD `client_id`,
   `payment-itemized:v1` basket) → wallet (in-page demo, Proof Cloud Wallet via handoff + return
   channel, or `navigator.credentials.get`) → RFC 8693 token exchange at `/x401/token` →
   `402` → x402 pay → `200`. The agent names its did:pkh in `X401-Agent-Id` on the first request; the
   proof — and so the payer — is bound to it. An optional `X401-Login-Hint` becomes the signed request's
   `login_hint` (whom Proof's handoff asks). The live deployment is a second, gated Render service on
   `x401.thisisandrew.me` (`render.yaml`, `docs/GO-LIVE.md`). Both gates 404 any non-canonical `/<sku>` path and refuse
   a malformed or ambiguous payment header. Standing mandates are Delegate Authority: the holder's credential key
   signs an L2 naming the agent key; the agent signs an L3 per purchase. `/buy` and July are untouched.

### Swappable seams (the load-bearing pattern)

Every external boundary is an interface + real impl + local/mock impl, selected by an env-driven
factory: `WALLET_MODE`, `FACILITATOR_MODE`, `PROOF_MODE`, `REVOCATION_MODE`, `LEDGER_MODE`,
`SESSION_STORE`, `WALLET_FLOW`. Latest-variant seams (`DcApiRequestSigner`, `PresentationVerifierV1`,
`DetachedSignatureResolver`, `NonceStore`, `L1Verifier`) go live only on an explicit
`LATEST_PROOF_MODE=live` (which refuses to boot without `PROOF_VERIFIER_KEY`, an https `PUBLIC_ORIGIN`,
a gated posture and the Fairfax pin); otherwise they run against the offline Proof emulator. Before adding a backend, wiring a new external dependency, or
writing offline tests, use the **`swappable-seams` skill** (`.claude/skills/swappable-seams/`) —
it lists every seam and the rules (mocks implement the real interface; no test-only branches in
prod code; cross-cutting retry/idempotency lives in one wrapper like `ResilientFacilitatorClient`;
validators return `ValidationResult`).

**Fail-closed is the recorded decision everywhere**: if the merchant/orchestrator cannot confirm
mandate status, cap headroom, ledger reachability, or (when exposed) auth secrets, the spend or
boot is denied. Keep that property when touching any of these paths.

### Live buyer (`packages/agent/src/live/`, docs/LIVE-BUY.md)

Pays *real* third-party x402 endpoints (discovered via the Bazaar). Defaults are dry-run + testnet;
`--yes` pays, `--mainnet` is real funds. One rule set (`live/guard.ts`) is applied twice: preflight
(`evaluateQuote`) and an in-path x402 `PaymentPolicy` with the recipient pinned to the preflighted
`payTo`, so terms cannot shift between check and pay. `live:grant` issues a wallet-bound
IntentMandate (`.live-mandate.json`) that `live:buy` verifies and enforces; spend journal is
`.live-spend.json`. Both files are gitignored — never commit them.

Env template: `.env.example` documents every mode/secret, including the fail-closed
`X401_ENCRYPTOR_KEY` and the three orchestrator access postures — local-dev open, gated
(`DEMO_AUTH_TOKEN`/`DEMO_SESSION_SECRET`), and deliberately public (`DEMO_OPEN_ACCESS`).
Exposed with neither a token nor the open flag refuses to boot, and `DEMO_OPEN_ACCESS`
refuses to coexist with `PROOF_MODE=live` or with either token. The latest variant adds
`PUBLIC_ORIGIN` (defaults to `RENDER_EXTERNAL_URL`, then localhost) — its live mode refuses an
http origin, since Proof must fetch the CIMD over https.

## Upstream x401 reference policy

This repository is public. Do **not** formally cite or link Proof's x401 repository — or any of
its pull requests, issues, or discussion threads — in code comments, docs, tests, README content,
or commit messages. Describe protocol concepts neutrally instead (e.g. "the wallet-native did:pkh
identity profile", "the proposed `payer_agent_mismatch` error") without attributing them to
upstream threads. The one sanctioned touchpoint is `scripts/check-x401-spec.mjs`
(`npm run check:x401`), whose repo identifiers exist only to poll for drift; its calls are
deliberately unauthenticated/anonymous — never add a token to it.
