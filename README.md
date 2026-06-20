# Agentic Payments Sandbox — x402 + Human-Identity Authorization

A working, testnet-only sandbox for **agent-initiated payments** over the
[x402 protocol](https://docs.cdp.coinbase.com/x402/welcome), with a research
layer that answers the question underneath agentic commerce: **which human
authorized this agent to spend, and within what scope?**

> **No real funds, no real wallet.** Everything runs on **Base Sepolia testnet**
> against the free facilitator (`https://x402.org/facilitator`), funded with
> faucet test USDC. The agent signs with a headless **Coinbase CDP Server
> Wallet** (or a throwaway viem key) — your MetaMask is never connected.

## Docs

- **[Architecture & Decisions](docs/ARCHITECTURE.md)** — the product-owner's
  "what & why": problem, concepts, decision log, safety guarantees.
- **[HAM Protocol Spec](docs/HAM-PROTOCOL.md)** — the Human Authorization Mandate
  data model, verification rules, and threat model.

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
apps/
  console/    # one-command demo: buyer + merchant consoles in the browser
```

## Demo console

```bash
npm run console   # then open http://localhost:4040
```

Boots the mock-CVS merchant in-process with mandate enforcement, the local OIDC
issuer, and the headless agent. In the browser: sign in (OIDC) → authorize the
agent by signing an Intent (cap + categories + expiry) → shop. In-scope buys
settle; out-of-scope buys are refused with the reason. The merchant panel shows
live orders with their state-machine status and settlement tx.

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
mandate chain but with the authorizing human's **OIDC identity bound into the
Intent**. Scope checks prove `Payment ⊆ Cart ⊆ Intent` (spend cap, merchant
allowlist, item categories, expiry). See `packages/shared/src/mandates.ts`.

## Develop

```bash
npm install
npm test          # vitest — 54+ tests across shared + merchant
npm run typecheck # tsc --noEmit, strict
```

## Status

- ✅ **Phase 0** — DRY shared core + state machine + validators
- ✅ **Phase 1** — x402 payment slice; offline E2E settles via mock facilitator
  (live Base Sepolia pending CDP key + faucet USDC)
- ✅ **Phase 2** — OIDC identity + HAM enforcement (Auth0 = one-line swap)
- ✅ **Phase 3** — buyer/merchant UX consoles (`npm run console`)
- ✅ **Phase 4** — docs ([architecture](docs/ARCHITECTURE.md) +
  [HAM spec](docs/HAM-PROTOCOL.md)), edge-case tests, `swappable-seams` skill

## Required to run the live testnet path (Phase 1)

All free; none touch a real wallet. See `.env.example`.

1. **CDP API key** — create at the Coinbase Developer Platform portal
   (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET`).
2. **Test USDC** — fund the printed agent wallet from `https://faucet.circle.com`
   (Base Sepolia). No ETH needed (gasless EIP-3009).

The offline test + demo path needs none of the above (`FACILITATOR_MODE=mock`).
