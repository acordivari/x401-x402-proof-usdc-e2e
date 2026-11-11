# Aligning with Proof's October 2026 x401 stack

**Verdict:** the demo now runs Proof's current x401 model end to end. The merchant is the verifier, the person's wallet answers a signed request, and the agent pays over x402 only after the proof clears. It's offline-complete today, and going live is a configuration step plus one enrollment I can't do from here.

The July build was a good read of x401 as it stood. It got the hard part right: it bound the payment into what the human signed, and it enforced spend at the merchant rather than in a well-behaved orchestrator. That July UI is preserved verbatim as the **July 2026** variant, one click away in the strip at the top of the page. Its server routes and all 256 of its tests are unchanged.

## What Proof shipped since July

Proof launched x401 in production on 2026-10-15. These are the pieces that matter for this project. I list them in the order they changed the design.

1. **Verifier identity is a URL, not an OAuth app.** A verifier hosts a Client ID Metadata Document (CIMD) at `/.well-known/proof-client.json` that publishes its ES256 key. The `client_id` *is* that URL. Enrollment is `npx @proof.com/proof-vc-server enroll <url> --email … --key …`, and no client secret is involved.
2. **The PROOF-REQUEST carries a signed DC API request.** The request is an `openid4vp-v1-signed` request object (`oauth-authz-req+jwt`, ES256) with `response_mode: dc_api` and `expected_origins`. The same bytes go to `navigator.credentials.get()`, to Proof's handoff endpoint, or to any wallet.
3. **Proof's "browser wallet" is the Cloud Wallet, reached by handoff.** `POST /verifiable-credentials/v1/x401-handoff` returns a `request_uri` link. With a `return_uri`, Proof POSTs the presentation back to the agent: the spec's intermediary return channel. (I found no browser extension or DC API wallet registration. Native `navigator.credentials.get` against a Proof credential is still unconfirmed.)
4. **Sign Transactions templates.** Four `transaction_data` types are defined: `payment-itemized:v1` (a checkout basket), `payment-mandate:v1` (recurring or standing charges), `session-data` (IP and device), and `wire-instructions:v1`. Each comes back verbatim as a top-level KB-JWT claim, so "terms match" is a direct comparison.
5. **x402-paid presentations.** A verifier with no card on file receives presentations with **both signature segments removed**. It buys them back from `/x401-signatures` over x402: USDC on Base Sepolia in sandbox, paid to `0x3b0b…13a0`, once per presentation, kept for 1 hour.
6. **`ProofCredentialV1` and fixed scopes.** `basic` discloses `given_name`, `family_name` and `age_equal_or_over.18`. `nationality:us` discloses `age_equal_or_over.18` and `is_national.us`. Ages are nested thresholds (18, 21 and 65), and the old free-form claim picker no longer maps to anything Proof issues.
7. **SDKs.** The packages are now `@proof.com/x401-node` 0.3.3 (the spec is still 0.2.0), `proof-vc-server`/`proof-vc-common` 0.6.3, `proof-vc-web` 0.6.0, and a new `x401-workers` 0.1.0. All of them require **Node ≥ 22.12**.
8. **Delegate Authority** is still early access. It has no published wire format, and it names Verifiable Intent as an example scope format.

## What the overhaul does with each

### Adopted as-is (works against Proof once enrolled)

| Proof capability | Where it lives | Notes |
|---|---|---|
| CIMD verifier identity | `packages/credentials/src/client-metadata.ts`, served at `/.well-known/proof-client.json` | Same shape the SDK's `createClientIdMetadataDocument` emits |
| Signed DC API request in PROOF-REQUEST | `dc-api-request.ts`; live path uses the SDK's `signedDcApiRequest` | Local signer is claim-for-claim identical, except it can carry 2 templates (the SDK helper takes 1) |
| Single-use nonce store | `nonce-store.ts` | Same `mint()/verify()` interface as `x401-workers` |
| Sign Transactions, terms match | `templates.ts` (`checkTerms`) | Itemized basket + session data per purchase |
| x401 token exchange → Verification Token | `packages/merchant/src/x401/gate.ts`, `x401-agent-v1.ts` | The spec's answer to "the nonce is single-use, but x402 needs two round trips" |
| `PROOF-RESULT` error objects | the gate | `invalid_nonce`, `terms_mismatch`, `policy_not_satisfied`, `mandate_revoked`, `invalid_token` |
| Live verification | `proof-sdk-v1.ts` → SDK `verifyVPToken({ aud })` | Chain to Proof's roots, plus a refusal of any non-`ProofCredentialV1` type (the SDK now only warns) |
| Detached signatures paid over x402 | `detached-signatures.ts`; live path is the SDK + an x402 `fetch` | Same wire as Proof's endpoint (client assertion, 402, 409 retry) |
| Handoff with return channel | `server/latest/index.ts` → `POST /x401/return/:rid` | Single-use, unguessable `rid` |

### Emulated offline (and labeled as such in the UI)

- **Proof itself.** `server/latest/proof-emulator.ts` speaks the `/x401-signatures` and `/x401-handoff` wire formats. The paywall is a real x402 paywall with a mock facilitator, and the "Cloud Wallet" is a hosted page running the demo wallet. This is how the public demo shows an x402-paid presentation with no Proof account.
- **The credential.** It's a self-issued `ProofCredentialV1`-*shaped* SD-JWT VC under a sandbox `vct`. A Proof-configured verifier refuses it, by design.
- **Delegate Authority.** The person's credential key signs an L2 mandate that names the agent's key, and the agent signs an L3 per purchase. It follows Verifiable Intent's autonomous mode, with two declared simplifications: clear mandates instead of nested disclosure, and a single merchant-facing L3. The human-readable terms are Proof's own `payment_mandate_v1` payload, so the person signs exactly what Proof's wallet would show.

### Kept from July, unchanged

The order state machine, the resilient settlement wrapper, the spend ledger and the revocation seams all carry over. The latest gate reuses the same `SpendLedger` for the mandate's cumulative budget, and the same `RevocationRegistry` for killing a mandate early.

## What I could not do, and what I'd need

1. **Enroll a live verifier.** Proof rejects enrollment on a public-suffix host (`public_suffix_host`), and `onrender.com` is one. The enrollment email also has to be on the CIMD's domain. *Update:* this is now planned for `x401.thisisandrew.me` as a second, gated Render service; the runbook is [GO-LIVE.md](./GO-LIVE.md). It needs **a domain you control** pointed at the service, then `LATEST_PROOF_MODE=live`, `PUBLIC_ORIGIN=https://<that domain>`, a `PROOF_VERIFIER_KEY` (P-256 PEM), and one `enroll` run with an address on that domain. An incomplete live config refuses to boot rather than quietly running offline.
2. **Pay for signatures with real testnet USDC.** That needs `PROOF_VERIFIER_EVM_KEY` holding Base Sepolia USDC. Without it, live verification fails closed on a 402 unless the Proof account has a card on file.
3. **Run live on the public URL.** `DEMO_OPEN_ACCESS` refuses to coexist with `PROOF_MODE=live`, which is the July rule kept on purpose. A live deployment means the gated posture (`DEMO_AUTH_TOKEN`).
4. **Use Proof's Delegate Authority.** It's early access (product@proof.com). Until it ships, the holder key lives in Proof's Cloud Wallet, so only the local wallet can sign an L2.
5. **Native DC API.** The button is wired and capability-detected, but I couldn't confirm any wallet that answers a Proof request through `navigator.credentials.get` today.

The `did:pkh` agent identifier and `payer_agent_mismatch` belong to a proposal, not the published 0.2.0 spec. I corrected the places this repo called them "normative".

## Numbers

- **Tests:** 256 before, 311 now, all offline. 21 are for the new credential layer, 13 are HTTP end-to-end tests of the latest variant (including the x402-paid signatures, the handoff, the age predicate, replay, Delegate Authority, the exposed public posture, and an offline boot of the live service's exact configuration), 10 are boot guards, and 11 reproduce review findings or cover their fixes (9 on the latest gate, 2 on July's).
- **Review:** an independent pass over the new code found 4 confirmed bugs. The 2 critical ones were a non-canonical path (`/sku/`, `%2D`) skipping the gate, and a decoy `X-Payment` header hiding the real payment from it — and **both also existed in July's `/buy` gate**. All 7 findings are fixed and pinned by regression tests: the 4 confirmed bugs, plus mandate keys scoped to the holder, the agent binding moved off a self-asserted field, and bounded emulator and session memory.
- **One latest purchase is 4 HTTP exchanges** (`401`, token `200`, `402`, `200`), plus 1 handoff when the Cloud Wallet path is used. The UI shows each one, decoded.
- **Wire:** x401 payload `0.2.0`, request objects valid for 300 s, Verification Tokens for 300 s, nonces for 600 s (sized for a relayed, human-paced approval).

**Next step I'd take:** stand the verifier up on a domain you own, enroll it in sandbox, and run one real Cloud Wallet presentation through the latest variant. That gives the demo its first live, x402-paid Proof presentation. Want me to script the enrollment and the gated Render posture for it?
