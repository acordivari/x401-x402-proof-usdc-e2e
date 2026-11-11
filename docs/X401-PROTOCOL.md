# x401 + Proof VC Authorization — Protocol Notes v0.2

> How this sandbox combines **x401** (identity proof over HTTP) with **x402**
> (payment over HTTP) so that *the human who authorized an agentic payment is
> cryptographically provable* — and bound to the **specific payment** — while the
> human discloses only what the verifier's scope asks for.

Status: two working reference implementations, side by side in one app.

- **Latest (default, Oct 2026)** — the merchant is the x401 verifier: signed DC API
  requests, a CIMD client id, Proof's Sign Transactions templates, x402-paid
  presentations, and Delegate Authority. §L1–L8 below.
- **July 2026 (preserved)** — the orchestrator is the verifier: a sealed-challenge
  payment binding and a server-signed HAM Intent. §1–§9 below, unchanged in substance.

Proof's side of the October changes, and what is still blocked, is in
[PROOF-ALIGNMENT-2026-10.md](./PROOF-ALIGNMENT-2026-10.md).

---

# Latest variant

## L1. Roles

| Role | In this repo | Responsibility |
|---|---|---|
| **Verifier** | the merchant — `packages/merchant/src/x401/gate.ts` over `X401VerifierV1` (`packages/credentials/src/x401-verifier-v1.ts`) | Signs the request, checks the presentation or delegation chain, enforces terms, policy, budget and revocation, then hands over to the x402 paywall |
| **Verifier identity** | a CIMD at `/.well-known/proof-client.json` (`client-metadata.ts`) | Publishes the ES256 key; its URL *is* the `client_id` |
| **User agent** | the orchestrator — `apps/wallet-demo/server/latest/` + `packages/agent/src/x401-buyer.ts` | Fetches, relays the PROOF-REQUEST unchanged, exchanges the result for a token, retries, pays |
| **Wallet** | demo wallet (`demo-wallet.ts`), Proof Cloud Wallet via handoff (emulated offline), or `navigator.credentials.get` | Authenticates the verifier, shows the terms, presents |
| **Issuer** | Proof (live) / `LocalCredentialV1Issuer` (offline, sandbox `vct`) | `ProofCredentialV1`: SD-JWT VC, nested age thresholds, holder key in `cnf` |

## L2. One purchase: a 401 and a 402

```
Agent ── GET /x401/buy/:sku  X401-Agent-Id: did:pkh:…  [X401-Login-Hint: email] ▶ Merchant (verifier)
      ◀─ 401  PROOF-REQUEST {credential_requirements.digital.requests[0] =
                {protocol: openid4vp-v1-signed, data: {request: <JAR>}},
              oauth.token_endpoint, payment: {required, scheme_hint: x402}}
         JAR (ES256, oauth-authz-req+jwt): client_id = CIMD URL, aud, nonce,
              scope = …:basic, expected_origins, response_mode = dc_api, [login_hint],
              transaction_data = [payment-itemized:v1, session-data]
Agent ── hands the request, unchanged, to a wallet ─▶ Wallet
      ◀─ {protocol, data: {vp_token}}   KB-JWT: nonce, aud = client_id, sd_hash,
                                        payment_itemized_v1, session_data
Agent ── POST /x401/token (RFC 8693, subject = Result Artifact, agent_id = did:pkh)
      ◀─ Verification Token (300 s, bound to this route)
Agent ── GET + PROOF-RESPONSE: <Token Object> ──▶ Merchant  ◀─ 402 PAYMENT-REQUIRED
Agent ── GET + PROOF-RESPONSE + PAYMENT-SIGNATURE ▶ Merchant ◀─ 200 receipt (+ authorization)
```

The token exchange is the spec's own answer to a real tension: the nonce is
single-use, and x402 needs two round trips. Retrying with the raw Result Artifact
also works (the spec requires verifiers to accept it). The merchant then checks the
nonce on the 402 leg and burns it on the paid one.

## L3. What the merchant checks before money moves

| Check | Where |
|---|---|
| Credential: issuer signature, disclosures, `typ: dc+sd-jwt`, pinned `iss`/`vct`, KB-JWT under `cnf`, `sd_hash`, `aud == client_id`, `iat` ≤ 300 s | `PresentationVerifierV1` — local key, or the SDK's `verifyVPToken({ aud })` |
| Detached signatures restored and paid for over x402 | the verifier's `DetachedSignatureResolver` (offline) / the SDK with an x402 `fetch` (live) |
| Nonce was issued by us, for **this route**, unexpired, and is single-use | `X401VerifierV1` + `NonceStore` |
| The scope's disclosures are all present | `scopeDefinition(scope).disclosures` |
| **Terms match**: every `transaction_data` sent comes back verbatim in the KB-JWT | `checkTerms` |
| Route policy, e.g. `age_equal_or_over.18 == true` for `otc-medicine` | `predicates(sku)` |
| Payer is the agent that requested the proof: it names its did:pkh in `X401-Agent-Id` on the first GET, the person signs that request's nonce, and the basket's `description` names the paying wallet. The artifact's `agent_id` (and a mandate's) must match, and the EIP-3009 `from` must be that wallet on our chain | the verifier + the gate, before settlement |
| Mandate still unexpired and unrevoked **at redemption** (a token is spent minutes after the exchange) | `X401VerifierV1.recheck` |
| One token, one purchase: claimed synchronously before any await | the gate |
| Only the canonical `/<sku>` path; payment header read exactly as x402 reads it, refused if malformed or two differ | the gate (and July's `mandate-gate`) |
| Paid amount is the catalog price | the gate |

Failures return a `PROOF-RESULT` x401 Error Object (`invalid_nonce`,
`terms_mismatch`, `policy_not_satisfied`, `mandate_revoked`, `invalid_token`,
`invalid_result`). The HTTP status describes only the response, as x401 requires.

## L4. Wallet paths — the spec's three ways to obtain a result

1. **Native.** `navigator.credentials.get({ digital })` with the request as sent. Wired
   and capability-detected. Whether any wallet answers a Proof request this way today
   is unconfirmed.
2. **Relay to a remote handler.** The orchestrator adds a single-use `return_uri` and
   POSTs the payload to Proof's `/x401-handoff`, which returns a `request_uri` link to
   the Proof Cloud Wallet. Proof POSTs the result back to the return channel. Offline,
   `server/latest/proof-emulator.ts` plays Proof, and the "Cloud Wallet" is a hosted
   page running the demo wallet. Relayed fulfillment does not enforce
   `expected_origins`, but the signature, `client_id`, audience and expiry still hold.
3. **In-page demo wallet.** Native-style invocation with the page as credential
   manager. It enforces the invoking origin against both `expected_origins` and the
   CIMD's `redirect_uris`.

## L5. x402-paid presentations

A verifier with no payment method at Proof receives
`<issuer-header>.<issuer-payload>.~…~<kb-header>.<kb-payload>.` with a critical
KB-JWT header `{"crit":["proof.com#sig-1"],"proof.com#sig-1":"<record id>"}`. It
POSTs the id with a `private_key_jwt` client assertion signed by its CIMD key. The
endpoint answers `402` until paid (x402 v2, `exact`, USDC on Base Sepolia in
sandbox), then `200 {issuer_signature, kb_signature}`. Unknown `crit` parameters are
rejected, as RFC 7515 requires. The receipt's `authorization.signaturePayments`
records what the merchant paid.

## L6. Standing mandates: Delegate Authority

The person's **credential key** signs the mandate; no server vouches for it.

```
L1  holder credential, selectively disclosed        <issuer-jwt>~<disclosures>~
L2  mandate, signed by L1's cnf key                 typ kb-sd-jwt+kb · sd_hash(L1) · jti · exp
      payment_mandate_v1: {prompt_summary, amount = cap, payee, payment_instrument}
      mandates[0]: {vct: mandate.payment.open.1, cnf: <agent key>, agent_id: did:pkh,
                    constraints: [budget, amount_range, allowed_payees, x-…allowed_categories]}
L3  one purchase, signed by the agent key           typ kb-sd-jwt · kid = mandate.cnf.kid
      aud = merchant client_id · nonce = merchant's · sd_hash(L1~L2~) · checkout + its hash
```

The merchant walks L3 → L2 → L1 → issuer and evaluates every stateless constraint.
It keeps three stateful checks for itself: the single-use nonce, the cumulative
budget (`SpendLedger`, keyed by the mandate's `jti`), and revocation
(`RevocationChecker`). Route predicates apply to the delegating person's disclosed
claims, so a mandate can't launder a missing `age_equal_or_over.18`. The readable
terms and the machine constraints must agree; minting refuses otherwise.

The shape follows Verifiable Intent's autonomous mode (the format Proof cites),
with two declared simplifications: mandates in clear rather than as nested
disclosures, and one merchant-facing L3 rather than separate L3a/L3b. Proof's own
Delegate Authority is early access, and its holder key lives in Proof's Cloud
Wallet, so live mode doesn't offer this path yet.

## L7. Seams added

| Seam | Implementations | Selected by |
|---|---|---|
| `DcApiRequestSigner` | `localRequestSigner` · `proofRequestSigner` (SDK) | latest live/local |
| `PresentationVerifierV1` | `localPresentationVerifierV1` · `proofPresentationVerifierV1` (SDK) | latest live/local |
| `DetachedSignatureResolver` | `httpSignatureResolver` against the emulator or Proof | (inside the verifier) |
| `NonceStore` | `InMemoryNonceStore` (interface matches `x401-workers`) | — |
| `L1Verifier` | `localL1Verifier` (live: none until Delegate Authority ships) | latest live/local |

## L8. Limits

Live mode is an explicit `LATEST_PROOF_MODE=live` that refuses to boot unless complete, and it needs an enrolled verifier. Proof rejects public-suffix hosts, so the
Render URL can't enroll. `DEMO_OPEN_ACCESS` refuses live mode, as in July. The
session-data template is local-only, because the SDK signs one `transaction_data`
per DC API request. Nonces, pending requests and Verification Tokens are
process-local, so a fleet needs a shared store behind each.

---

# July variant (preserved)

## 1. The idea in one paragraph

x402 moves money but is identity-agnostic. Our **HAM** layer already binds *which
human* approved an agent via a signed Intent — previously sourced from an **OIDC**
login. x401 replaces that identity source with a **verifiable-credential
presentation**: the verifier issues a `PROOF-REQUEST` challenge carrying a DCQL
query (which claims it wants) and a **payment `transaction_data`** (what it wants
authorized); the holder's wallet returns a `vp_token` (an SD-JWT-VC + key-binding
JWT) that discloses **only the requested claims** and is bound to both the
challenge nonce and the payment. The verifier checks all of it, then issues the
HAM Intent that gates x402 settlement. So "who authorized *this* payment" is
answered by a selectively-disclosed, payment-bound credential.

---

## 2. Roles

| Role | In this repo | Responsibility |
|---|---|---|
| **Holder (Human)** | Proof wallet (live) / `LocalWallet` (offline) | Holds the SD-JWT-VC; selectively discloses claims; signs the KB-JWT over the nonce. |
| **Issuer** | Proof (live) / `LocalVcIssuer` (offline) | Issues the `proof_id_default` SD-JWT-VC, holder key bound via `cnf`. |
| **Verifier / Authorization Service** | orchestrator + `packages/credentials` + `AuthorizationService` | Builds the x401 challenge + payment `transaction_data`, verifies the presentation, issues the signed Intent. |
| **Agent** | `packages/agent` | Holds the payment wallet; pays via x402 with the issued Intent. |
| **Merchant** | `packages/merchant` (`mandate-gate.ts`) | Verifies `Payment ⊆ Cart ⊆ Intent` + cap, then settles. **Unchanged** by x401. |

`@proof.com/x401-node` provides only the wire format (the Digital Credentials
request `credential_requirements.digital`, the Result Artifact, the
PROOF-REQUEST/RESPONSE/RESULT headers, token exchange). The Verifier Challenge +
encryptor that seal the payment binding into the nonce were dropped from the SDK
in 0.2.0, so we vendor that primitive (`packages/credentials/src/x401-binding.ts`)
and carry the challenge + vp_token inside the Result Artifact's (opaque)
`credential_result.data`. The SDK never verifies credentials and never drives the
wallet — we supply both.

---

## 3. The combined flow

```
Phase A — identity + payment authorization (x401 + Proof + transaction_data)
 1. Verifier builds payment transaction_data (payment-mandate v1) from its own
    catalog price, and an x401 challenge with that payment's digest sealed in.
 2. Verifier returns PROOF-REQUEST { credential_requirements.digital (dcql/scope
    + challenge nonce), oauth }.
 3. Wallet selectively discloses the requested claims and signs a KB-JWT over
    the nonce → vp_token  (live: Proof hosted redirect; offline: in-browser).
 4. Verifier verifies: challenge (resource/method/expiry) + SD-JWT-VC (issuer
    signature, holder cnf binding, KB nonce, required claims) + payment binding
    (recomputed transaction_data digest == the digest sealed in the challenge).
 5. AuthorizationService maps the disclosed subject → Principal and signs a HAM
    Intent (principal.verifiedVia = "x401-vp", with a credential audit ref).

Phase B — payment (x402 + HAM) — existing code, unchanged
 6. Agent pays /buy via x402 with the Intent; mandate-gate enforces
    Payment ⊆ Cart ⊆ Intent + cumulative cap; the facilitator settles.
```

---

## 4. Selective disclosure (DCQL)

Credentials are **SD-JWT-VC**: every `proof_id_default` claim (`given_name`,
`family_name`, `birth_date`, `email`, `document_number`, `nationality`,
`issuing_country`, `age_over_18`, `age_over_21`) is an independent disclosure.
The verifier's **DCQL query** names exactly which it wants; the wallet reveals
that subset and **withholds the rest** (e.g. disclose `age_over_21` without
revealing `birth_date`). `requiredClaims` on the verifier side fails the
presentation if a required claim was not disclosed.

---

## 5. The 401↔402 join: `transaction_data`

Proof's OID4VP endpoint accepts `transaction_data` of type
`urn:proof:params:vc:transaction-data:payment-mandate:v1` — details the End-User
explicitly authorizes. We carry the agent's payment (amount, merchant, asset,
network, sku) there. The returned presentation is bound to its digest, and we
seal the **same digest into the x401 challenge** (authenticated by the challenge
encryptor). Verification recomputes the digest from the presented payment and
requires a match — so a presentation captured for one payment **cannot be
replayed against a different amount or merchant** (`txDataBound`).

---

## 6. What the verifier proves (and the checks)

| Property | Check |
|---|---|
| Challenge authenticity / freshness | `verifier.verifyChallenge` — verifier id, resource, method, expiry, encryptor-sealed state |
| Genuine credential | Live: `@proof.com/proof-vc-server` `verifyVPToken` verifies the SD-JWT-VC issuer `x5c` chain (ES256) against Proof's committed trust store (chosen by environment since proof-vc-server 0.5; the July `trustRoot` knob maps onto it). Local mode uses a resolved issuer key instead. (A hand-rolled x5c fallback verifier existed pre-SDK; removed 2026-07 — see git history.) |
| Holder actually presented it | KB-JWT verified against the credential's `cnf` key (`holderBound`) |
| Anti-replay | KB-JWT `nonce` == challenge value (`nonceBound`) — enforced by our adapter; SDK 0.3.x exposes the nonce (`getNonce()`) instead of checking it |
| Right info disclosed | DCQL `requiredClaims` all present |
| Bound to *this* payment | recomputed `transaction_data` digest == sealed digest (`txDataBound`) |

Any failure ⇒ the presentation is rejected and **no Intent is issued**, so x402
never runs.

---

## 7. Seam design (matches the repo doctrine)

`VerifiableCredentialVerifier` is a swappable seam with **two** implementations
behind one interface (like `FacilitatorClient` and `IdentityVerifier`):

| Verifier | Trust source | Used by |
|---|---|---|
| `localVcVerifier` | a pinned self-issuer key (`LocalVcIssuer`) | the offline / self-issued path, tests, CI |
| `proofSdkVcVerifier` | `@proof.com/proof-vc-server` `verifyVPToken`, pinned to Proof's committed trust store (`trustRoot` → SDK environment) | the live Proof-hosted path |

`createVcVerifier({ mode, proof })` selects one (`PROOF_MODE`). Mocks implement
the real interface, so tests exercise the same verification path as live. (A
third, hand-rolled x5c chain-walk verifier predated the SDK adoption and was
removed once every live caller went through the SDK.)

### The three wallet workflows

The demo exposes a `WALLET_FLOW` selector (switchable live in the UI) over the
same x401 → HAM → x402 spine:

| Workflow | Identity | Per-purchase human? | Drives |
|---|---|---|---|
| **Self-issued** | browser-held local SD-JWT-VC | yes (in-browser consent) | `localVcVerifier` + `LocalWallet` |
| **Proof-hosted** | real Proof wallet | yes (Proof hosted screen) | `proof-vc-server` client `authorizationUrl` (PAR) + `verifyVPToken`; the official `<proof-verify-id>` web component (`proof-vc-web`) launches the request with our PAR-built URL |
| **Delegated** (autonomous) | one upfront grant (either of the above) | **no** | a durable, scoped `IntentMandate` the agent spends within |

### Delegated mandate (presigned identity = authorization)

The human makes **one** selective-disclosure presentation that authorizes a
*budget grant* (a `payment-mandate` whose `prompt_summary` is the standing
instruction and whose amount is the cap) instead of a single payment. The
Authorization Service issues **one long-lived** `IntentMandate` (`merchantAllowlist`
+ `allowedCategories` + `maxAmount` + a `MANDATE_TTL` expiry). The agent then
settles **many** purchases over x402 with **no further human approval** — the
signed Intent is the standing authorization. The merchant's `SpendLedger`
(`LEDGER_MODE`: in-memory, durable file, or a central HTTP service that's **global
across merchants**, fail-closed) enforces the **cumulative cap across purchases**, so
an over-budget or out-of-scope buy is denied on its own, with nobody in the loop
(`POST /api/agent/run`; `test/e2e-delegated.test.ts`). This is the up-front
authorization model HAM was designed for — a headless agent can't complete a
human-in-the-loop redirect mid-`/buy`, so the human pre-authorizes a scope once.

**Revocation.** A durable mandate would be unstoppable until expiry, so the issuer
can **revoke** it early: `AuthorizationService.revokeIntent(id)` records it, and the
merchant gate refuses any further spend against that Intent — even though it's still
validly signed, in-scope, under-cap, and unexpired. Revocation is by mandate `id`,
permanent, and checked *before* the cap reservation, so a leaked or compromised
standing mandate is killed at the merchant the moment it's revoked
(`POST /api/mandate/revoke`; `test/e2e-revocation.test.ts`).

The merchant reads status through the `RevocationChecker` seam, selectable via
`REVOCATION_MODE`: an **in-process** `RevocationRegistry` (default), or an **HTTP**
`httpRevocationChecker` against the issuer's status endpoint (OCSP / status-list
style) so issuer and merchant can be separate services. The HTTP path is
**fail-closed** — if the merchant can't confirm "not revoked" (unreachable, timeout,
non-200, ambiguous), the spend is denied. (See ARCHITECTURE.md §8.)

### Orchestrator session model (who may spend a mandate)

The demo orchestrator is **per-client isolated** in every posture: each browser gets a
signed, HttpOnly `SameSite=Lax` session cookie, and all per-client state (`flow`,
the in-flight x401 attempt, the issued `intent`) lives in that session — so one
client can never see or spend another's mandate. Isolation is the cookie's job, not
the gate's, and it is unaffected by how access is configured. `SameSite=Lax` is the
CSRF mitigation.

Access itself has three postures. **Local dev** is open (no token, nothing to set).
**Gated** sets a shared `DEMO_AUTH_TOKEN` in front of every state/spend endpoint
(`POST /api/login`, timing-safe compare, 10 attempts/min/IP). **Open**
(`DEMO_OPEN_ACCESS=true`) removes the gate entirely, so a public visitor lands on a
working demo with nothing to copy — the posture the hosted demo runs in. Exposure
(`NODE_ENV=production` or `DEMO_REQUIRE_AUTH=true`) is a separate axis that turns on
fail-closed secrets, `Secure` cookies and HSTS; exposed with **neither** a token nor
the open flag **refuses to boot**, mirroring the `X401_ENCRYPTOR_KEY` guard.

Going open is sound only because the orchestrator **cannot move value** — the agent
signer is a throwaway key generated at boot and the facilitator is hard-wired to
`mock` — and config keeps it that way by **refusing to boot** when `DEMO_OPEN_ACCESS`
is combined with `PROOF_MODE=live` (which would let any visitor spend the operator's
Proof credentials) or with either token, since a credential that no longer gates
anything reads like protection that isn't there. Two properties move with the gate:
state-changing `/api/*` calls take a 120/min/IP cap (GETs exempt — the UI polls
them) now that the login throttle no longer stands in front of the signing and
verification routes, and session rows are persisted only once a request actually
mutates one, so a crawler cannot fill the store by sweeping an ungated demo.

`DEMO_PUBLIC_TOKEN` remains as the halfway house: a second, deliberately publishable
credential that `GET /api/me` returns pre-auth (the only field it serves beyond gate
status) so the login screen can render it with a copy button and a shareable
`<origin>/#token=…` unlock link, on its own looser throttle (60/min/IP) because a
printed token is not one anyone has to guess. The fragment carries the token
client-side only — never into a query string, proxy log, or `Referer`. It keeps
`DEMO_AUTH_TOKEN` private and independently rotatable, and is subject to the same
boot refusals. For a genuinely public demo `DEMO_OPEN_ACCESS` supersedes it: the
visitor never handles a token at all.
Tests: `test/e2e-demo-server.test.ts` (isolation), `test/e2e-demo-auth.test.ts`
(gate + published token + fail-closed), `test/e2e-demo-open.test.ts` (open posture,
write cap, boot refusals). Note: the agent wallet is shared infrastructure; isolation of
*authority* holds because each session holds only its own `intent`. The in-memory
session store is single-process (fine for the demo; a real deployment would back it
with a shared store).

---

## 8. Threat model & current limits

| Threat | Defense |
|---|---|
| Agent acts with no human behind it | No valid presentation ⇒ no Intent ⇒ refused. In the **delegated** flow the human still presents once up front; the agent's autonomy is bounded by that signed scope + cap + expiry. |
| Standing mandate leaked / agent compromised | The issuer **revokes** the Intent (`revokeIntent`); the merchant refuses every subsequent spend against it, independent of scope/cap/expiry (`RevocationChecker`). |
| Tampered / forged credential | SD-JWT issuer signature must verify against a trusted key. |
| Stolen presentation replayed | KB-JWT nonce bound to a single-use challenge. |
| Presentation reused for a different payment | `transaction_data` digest binding (`txDataBound`). |
| Over-disclosure | DCQL selective disclosure; wallet reveals only requested claims. |
| A different wallet rides the Intent | Merchant checks `payer == agentWallet` (existing HAM). |

**Limits (sandbox):** the SDK verifier (`proofSdkVcVerifier`) pins to Proof's
committed trust store (`trustRoot` `development` → SDK environment `sandbox` for
the Fairfax sandbox, `production` for prod) — so the open "pin the actual Root CA" item is resolved for
the live path. In the **self-issued** and
**proof-hosted** flows the holder presents once per purchase; the **delegated**
flow is exactly the reusable-mandate model — one presentation authorizes many
autonomous purchases within the signed scope/cap/expiry. Note: live Proof also
binds the payment *inside* the holder-signed KB-JWT (`payment_mandate_v1`), which
we surface as `paymentApproved`; our independent challenge-sealed digest binding
is enforced in addition.

---

## 9. Relationship to HAM / AP2 / x402

x401 is an **alternative, richer identity source for HAM**: instead of OIDC →
Intent, it is VC-presentation → Intent, plus a payment binding HAM/AP2 leave
open. Everything downstream of the signed Intent (Cart/Payment scope checks,
cumulative cap, x402 settlement) is unchanged. See
[HAM-PROTOCOL.md](./HAM-PROTOCOL.md).
