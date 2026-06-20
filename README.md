# Agentic Payments Sandbox — x402 + Human-Identity Authorization

A working, testnet-only sandbox for **agent-initiated payments** over the
[x402 protocol](https://docs.cdp.coinbase.com/x402/welcome), with a research
layer that answers the question underneath agentic commerce: **which human
authorized this agent to spend, and within what scope?**

> **No real funds, no real wallet.** Everything runs on **Base Sepolia testnet**
> against the free facilitator (`https://x402.org/facilitator`), funded with
> faucet test USDC. The agent signs with a headless **Coinbase CDP Server
> Wallet** (or a throwaway viem key) — your MetaMask is never connected.

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
  agent/      # headless buyer agent (CDP Server Wallet -> x402 client)   [in progress]
  identity/   # OIDC + Human Authorization Mandate (HAM)                  [Phase 2]
```

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

- ✅ **Phase 0** — DRY shared core + state machine + validators (tested)
- 🚧 **Phase 1** — x402 payment slice (merchant settlement core done; agent +
  live Base Sepolia settlement pending CDP key + faucet USDC)
- ⏳ **Phase 2** — OIDC identity + HAM enforcement
- ⏳ **Phase 3** — buyer/merchant UX consoles

## Required to run the live testnet path (Phase 1)

All free; none touch a real wallet. See `.env.example`.

1. **CDP API key** — create at the Coinbase Developer Platform portal
   (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET`).
2. **Test USDC** — fund the printed agent wallet from `https://faucet.circle.com`
   (Base Sepolia). No ETH needed (gasless EIP-3009).

The offline test + demo path needs none of the above (`FACILITATOR_MODE=mock`).
