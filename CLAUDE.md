# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A testnet-only sandbox for agent-initiated payments over the x402 protocol, plus the research
contribution: the **Human Authorization Mandate (HAM)** layer answering "which human authorized
this agent to spend, and within what scope?". TypeScript ESM, npm-workspaces monorepo, Node >= 20.
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

Read `docs/ARCHITECTURE.md` for the what/why; `docs/HAM-PROTOCOL.md` and `docs/X401-PROTOCOL.md` for specs.

### Workspace layout

- `packages/shared` — the DRY core imported by everyone: Zod wire schemas (x402 v2), money math,
  order state machine, HAM mandate model + scope validators, `ValidationResult`, `PaymentSigner`
  interface, clock helpers. Never redefine these locally.
- `packages/merchant` — seller: catalog, state-machine-guarded `order-store`, `mandate-gate`,
  `spend-ledger`, and the facilitator seam (`facilitator/mock.ts`, `facilitator/resilient.ts`).
- `packages/agent` — headless buyer (`buyer.ts`, `x402-client.ts`, `wallet.ts`) + `src/live/` buyer.
- `packages/identity` — OIDC verifier (local | Auth0), HAM signing/verification, revocation checkers.
- `packages/credentials` — x401 verifiable-credentials seam: SD-JWT-VC issue/hold/present, DCQL
  selective disclosure, `transaction_data` payment binding, local vs Proof-SDK verifiers.
- `apps/wallet-demo` — Vite+Svelte wallet UI + the Express orchestrator (`server/`, exported as
  `createDemoApp` so HTTP e2e tests import it).

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

### Swappable seams (the load-bearing pattern)

Every external boundary is an interface + real impl + local/mock impl, selected by an env-driven
factory: `WALLET_MODE`, `FACILITATOR_MODE`, `PROOF_MODE`, `REVOCATION_MODE`, `LEDGER_MODE`,
`SESSION_STORE`, `WALLET_FLOW`. Before adding a backend, wiring a new external dependency, or
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
`X401_ENCRYPTOR_KEY` and demo auth-gate (`DEMO_AUTH_TOKEN`/`DEMO_SESSION_SECRET`) semantics.
