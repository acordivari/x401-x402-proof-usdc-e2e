# Human Authorization Mandate (HAM) — Protocol Spec v0.1

> A protocol for binding a **verified human identity** to an **AI agent's scoped
> spending authority**. HAM layers on Google **AP2**'s mandate model and
> Coinbase **x402**'s payment rail, filling the gap both leave open: *how a
> specific, authenticated human authorizes an agent — and how a merchant
> verifies it before taking money.*

Status: working reference implementation in this repo (`packages/identity`,
`packages/shared/src/mandates.ts`, `packages/merchant/src/mandate-gate.ts`).
This is a sandbox spec meant to evolve.

---

## 1. Why HAM

- **x402** moves money over HTTP but is identity-agnostic — a wallet signs,
  nothing ties it to a consenting person or a budget.
- **AP2** defines an Intent → Cart → Payment **mandate chain** and says mandates
  are signed Verifiable Credentials, but leaves *how human identity is captured
  and bound* to integrators (its identity partners include Auth0/Okta).

HAM is the concrete binding: **OIDC authenticates the human; a signed Intent
mandate carries that identity + a spending scope; the merchant verifies the
chain before settlement.**

---

## 2. Roles

| Role | In this repo | Responsibility |
|---|---|---|
| **Human (Principal)** | the buyer | Authenticates via OIDC; approves a scope. |
| **Identity Provider (IdP)** | local OIDC issuer / Auth0 | Issues a signed ID token asserting the human's identity. |
| **Authorization Service (AS)** | `AuthorizationService` | Verifies the ID token, then **issues + signs** Intent mandates. The merchant's trust anchor. |
| **Agent** | `packages/agent` | Holds a wallet; presents the signed Intent and pays via x402. |
| **Merchant / Verifier** | `mandate-gate.ts` | Verifies the mandate chain + scope + cumulative cap **before** settling. |

---

## 3. Mandate chain

Three mandates, narrowing from intent to a concrete payment. The relationship the
verifier must prove is **`Payment ⊆ Cart ⊆ Intent`**.

### 3.1 Intent mandate (signed by the Authorization Service)

The human authorization. Binds the verified OIDC principal to **one agent
wallet** and a **spending scope**.

```jsonc
{
  "type": "IntentMandate",
  "id": "<uuid>",
  "principal": {                 // from the verified OIDC ID token
    "sub": "auth0|abc",
    "idp": "https://tenant.auth0.com/",
    "email": "buyer@example.com",
    "emailVerified": true
  },
  "agentWallet": "0x…",          // the only wallet this Intent authorizes
  // Wallet-native did:pkh form of the same binding. Optional for
  // pre-existing signed mandates; when present the CHAIN ID is part of the
  // identity a verifier must match the payer against.
  "agentId": "did:pkh:eip155:84532:0x…",
  "scope": {
    "maxAmount": "5000000",      // atomic USDC cap for the WHOLE intent
    "currency": "USDC",
    "merchantAllowlist": ["0x…"],
    "allowedCategories": ["otc-medicine", "vitamins"]
  },
  "issuedAt": 1700000000,        // unix seconds
  "expiresAt": 1700003600,
  "nonce": "<uuid>",             // replay id (jti-like)
  "proof": {                     // detached EdDSA signature (see §4)
    "alg": "EdDSA", "kid": "auth-service-1", "signature": "<compact-JWS>"
  }
}
```

**Issuance-time account control.** When the Authorization
Service is configured with an `AccountControlVerifier`, it refuses to sign an
Intent unless the agent proves it *controls* the wallet being bound: the agent
personal-signs `buildWalletControlMessage(agentId, challenge)` — EIP-191 for
EOAs (verified by pure secp256k1 recovery, offline), ERC-1271/ERC-6492 for
smart accounts (on-chain, fail-closed on RPC failure). On the x401 path the
proof must be bound to the **same single-use challenge** as the human's
presentation, so one request context covers all three proofs: the human's
selective disclosure, the payment digest, and the agent's wallet control.

### 3.2 Cart mandate (derived by the merchant from its catalog)

The specific items + price. **Built server-side from the merchant's own catalog**
(not from agent input) so the verified amount is the merchant's true price.

```jsonc
{
  "type": "CartMandate", "id": "<uuid>",
  "intentId": "<intent uuid>",
  "merchant": "0x…",
  "items": [{ "sku": "…", "name": "…", "category": "otc-medicine",
              "unitPrice": "1500000", "quantity": 1 }],
  "total": "1500000",            // MUST equal sum(unitPrice*quantity)
  "currency": "USDC",
  "issuedAt": 1700000000, "expiresAt": 1700000600, "nonce": "<uuid>"
}
```

### 3.3 Payment mandate (from the agent's x402 authorization)

Links the on-chain payment to the cart. Its `amount` is the value the agent
actually **signed** in the EIP-3009 authorization.

```jsonc
{
  "type": "PaymentMandate", "id": "<uuid>",
  "cartId": "<cart uuid>",
  "payTo": "0x…", "asset": "0x…USDC",
  "amount": "1500000",           // the agent-signed value
  "network": "eip155:84532",
  "nonce": "0x…"                 // the EIP-3009 nonce (replay protection)
}
```

---

## 4. Signing & canonicalization

- **Algorithm:** EdDSA (Ed25519). The Intent is signed by the AS key; the
  merchant trusts that key (by `kid`) — in production via the AS's JWKS.
- **Canonical form:** the mandate object **minus `proof`**, serialized with
  recursively **sorted keys** and `undefined` fields omitted
  (`identity/src/mandate.ts → canonicalize`). This makes the signed bytes
  deterministic regardless of property order.
- **Proof:** a compact JWS over the canonical bytes, stored in
  `proof.signature`. Verification recomputes the canonical form and checks the
  signature against the trusted key for `proof.kid` — so **any tampering**
  (e.g. raising `maxAmount`) invalidates the proof.

> In this sandbox the Cart and Payment mandates are constructed by the trusted
> merchant from its own catalog + the agent's signed x402 payment, so they don't
> need independent signatures — the merchant *is* their source of truth. A
> fuller deployment could sign carts (agent or AS) for a richer audit trail; the
> `MandateProof` field is already on every mandate type.

---

## 5. Verification (what the merchant checks before settling)

On each `/buy`, the gate (`mandate-gate.ts`) enforces, in order:

1. **Mandate present** — else `401 authorization mandate required`.
2. **Intent signature** valid against a trusted key (`verifyProof`).
3. **Cart ⊆ Intent** via the shared validator (`validateCartAgainstIntent`):
   - cart bound to this intent (`intentId`),
   - intent **active** (`issuedAt ≤ now < expiresAt`) — both halves, closing the
     future-dated-intent gap,
   - `merchant ∈ merchantAllowlist`,
   - every item `category ∈ allowedCategories`,
   - `total == Σ(unitPrice·qty)` and `total ≤ scope.maxAmount` (per-purchase cap).
4. **Cumulative cap** — `committed + reserved + thisPrice ≤ maxAmount`
   (the spend ledger; see §6).
5. On the paid request additionally:
   - **Payer ⊆ Intent** (`validatePayerAgainstIntent`): the payer identity
     derived from the signed EIP-3009 authorization (`from` + the chain it
     settles on) must match `agentWallet` — and, when the Intent carries a
     wallet-native `agentId` (did:pkh), the **chain id is part of the
     identity**. A mismatch is refused *before settlement* with the
     normative `payer_agent_mismatch` error,
   - **Payment ⊆ Cart** (`validatePaymentAgainstCart`): `payTo == merchant` and
     `amount == cart.total` — i.e. the agent signed for **exactly the merchant's
     price**.

Any failure ⇒ `403` with machine-readable `violations`. Only after all pass does
the x402 paywall verify + settle.

---

## 6. Cumulative-cap accounting (the spend ledger)

`scope.maxAmount` caps **total** spend across many purchases under one Intent.
Enforced with a reserve→commit/release ledger (the `SpendLedger` seam:
in-memory, durable file, or central HTTP service) keyed by EIP-3009 nonce,
tied to the settlement lifecycle:

- **reserve** at authorization (gate), against `committed + reserved`,
- **commit** on settle success (the reserved amount becomes committed),
- **release** on settle failure **or** if the request doesn't end `200`
  (so a payment the paywall later rejects can't strand a reservation).

This guarantees every reservation is matched by exactly one commit or release —
no phantom spend, no double count.

---

## 7. Threat model (what HAM defends against, and current limits)

| Threat | Defense |
|---|---|
| Agent spends with no human behind it | No mandate ⇒ refused (401). |
| Tampered scope (raise the cap, add a merchant/category) | Breaks the EdDSA proof ⇒ refused. |
| Forged mandate | Signature must verify against a **trusted** key (`kid`). |
| Agent pays itself / a different merchant | `payTo == merchant` checked. |
| Agent underpays to dodge the cap | Cart total = **catalog price**; `amount == total` enforced. |
| A different wallet rides a stolen Intent | Payer ⊆ Intent: `payer == agentWallet`, plus the did:pkh `agentId` (chain-inclusive) ⇒ `payer_agent_mismatch`. |
| Same wallet key replayed on another chain | The did:pkh `agentId` folds the chain id into the identity; a cross-chain payer mismatches. |
| Mandate binds a wallet the agent doesn't control | Issuance-time wallet-control proof (EIP-191 / ERC-1271), challenge-bound, required whenever the seam is configured. |
| Over-budget across many buys | Cumulative spend ledger. |
| On-chain replay of a payment | EIP-3009 nonce is single-use on USDC. |
| Reservation leak exhausting the cap | Released on non-200 finish (regression-tested). |

**Known limitations (sandbox):** no hard serialization between concurrent
settlements of the same Intent (cap is best-effort under high concurrency); the
AS key is in-process (real deployments publish a JWKS and rotate); Cart/Payment
mandates are merchant-derived rather than independently signed; ID-token
freshness/`nonce` binding to the OIDC `nonce` claim is not yet enforced.

---

## 8. Relationship to AP2 & x402

- **AP2:** HAM uses AP2's Intent→Cart→Payment chain shape and "signed mandate"
  idea, and makes the **identity binding** concrete via OIDC — the part AP2's
  public spec leaves to integrators.
- **x402:** HAM sits **in front of** x402. x402 (and its facilitator) still owns
  the actual payment/settlement; HAM is the authorization gate that decides
  whether a given x402 payment is *allowed* to proceed.

## 9. Roadmap

- Publish the AS key as a **JWKS** the merchant fetches (real trust distribution).
- Bind the OIDC **`nonce`/`at_hash`** to the Intent to prevent token replay.
- Optionally **sign Cart mandates** for a fully non-repudiable item-level trail.
- **Step-up auth** for high-value carts (re-authenticate the human).
- Cross-merchant Intents and a shared, queryable **spend ledger**.
- Formalize the wire format (headers, error codes) as an interoperable profile.
