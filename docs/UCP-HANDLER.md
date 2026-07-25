# UCP Checkout `payment_handler` — Protocol Notes v0.1

## 1. The idea in one paragraph

The Universal Commerce Protocol (UCP — Shopify + Google, `ucp.dev`) separates
what a checkout *accepts* (Payment Instruments) from *how* an instrument is
processed (Payment Handlers), and lets any vendor register its own handler
under a `com.{vendor}.*` namespace — no core-spec change, no committee vote.
UCP's own "Scenario C" (autonomous agent / AP2) wants exactly what this repo's
HAM (Human Authorization Mandate) layer already produces: a signed mandate
giving the merchant non-repudiable proof a human authorized the spend. This
doc describes a small, spec-shaped REST responder + client pair that plugs a
HAM-secured, x402-settled handler into that slot, reusing every existing seam
(mandate verification, spend ledger, revocation, the merchant's own
`x402ResourceServer`) unchanged.

## 2. Roles

- **Payment Credential Provider** — the identity + enforcement layer: whichever
  x401 identity vendor issued the human's verifiable credential (Proof today,
  swappable per `docs/X401-PROTOCOL.md` §7), plus this repo's `AuthorizationService`
  / `SpendLedger` / `RevocationChecker` enforcing the mandate.
- **Business** — the merchant, `packages/merchant/src/ucp/`. Unchanged catalog,
  unchanged order state machine, unchanged mandate-gate *logic* — just a second
  wire format (JSON checkout sessions) alongside the existing GET+headers `/buy`.
- **Platform** — the agent, `packages/agent/src/live/ucp-checkout.ts`. Discovers
  the merchant's declared handler from a checkout-session response and completes
  it with a HAM-secured credential.

## 3. The two routes

```
POST /ucp/checkout-sessions
  { "line_items": [{ "sku": "allergy-relief-24", "quantity": 1 }] }
  -> 200 UcpCheckoutSession { id, status: "incomplete", totals, payment_handlers }

POST /ucp/checkout-sessions/{id}/complete
  { "payment": { "instruments": [{
      "handler_id": "ham-settlement-v1",
      "type": "ham_mandate",
      "credential": { "type": "ham_mandate", "intent": "<base64 IntentMandate>", "payment": <PaymentPayload> }
  }]}}
  -> 200 { status: "completed", order: { state: "SETTLED", txHash, pollUrl } }
  -> 4xx { messages: [{ type: "error", code, content }] }   (UcpErrorResponse)
```

`GET /.well-known/ucp` publishes the business profile declaring the
`com.agentic-payments.ham_settlement` handler (see §7 for the namespace caveat).

## 4. Why `complete_checkout` carries a full signed payment, not a token

UCP's own lifecycle is Negotiation → Acquisition → Completion, where
Acquisition happens Platform↔PaymentCredentialProvider directly — the business
is not involved. Mapped onto this sandbox, the agent already has everything it
needs (a HAM Intent + a signer) before calling `complete`, so `credential.token`
here is genuinely two things bundled together: the Intent (proof of
authorization) and a signed x402 `PaymentPayload` (proof of funds). The
merchant verifies and settles both directly via `x402ResourceServer.verifyPayment`
/ `.settlePayment` — the same primitives `@x402/express`'s `paymentMiddleware`
calls internally for the plain `/buy` route, just invoked directly instead of
through an HTTP 402 challenge/retry cycle (there's no lower-level SDK gap here;
`paymentMiddleware` is a thin transport wrapper around exactly these two calls).

On the agent side, `signUcpPayment` builds that payload without an actual 402
round trip either — `x402Client.createPaymentPayload(paymentRequired)` is the
same primitive `wrapFetchWithPayment` calls once it has decoded a *real* 402
response; here we construct the `PaymentRequired` envelope ourselves from the
checkout session's quoted total instead of parsing one off the wire.

## 5. Server-owned truth

Exactly like `mandate-gate.ts`, `complete_checkout` recomputes the Cart from
the catalog + the line item the session was *quoted* for — never from anything
the request body claims. A session tracks its one line item server-side
(`sessionLineItem` map in `checkout-routes.ts`); the credential can only ever be
checked against that stored quote, so a completion request cannot smuggle in a
different price or sku than what was negotiated.

## 6. Encoding choices

- `credential.intent` — base64(JSON(IntentMandate)), the *same* encoding as the
  existing `x-authorization-mandate` header. Kept as an opaque string (matching
  UCP's own "credentials are opaque, businesses forward but don't inspect them"
  philosophy, and how AP2's own `checkout_mandate` is carried as an opaque
  JWT-like string) rather than a nested object.
- `credential.payment` — a nested `PaymentPayload` object, not re-encoded as a
  string. Unlike the Intent, the x402 payment payload has no header-length
  constraint here (we're already inside a JSON body), so there's no reason to
  add an extra encode/decode round trip.

## 7. Explicitly out of scope for this pass

- **No live external merchant.** `createUcpCheckoutClient({ baseUrl })` will
  happily point at a real UCP business, but nothing here has been run against
  one — there is no pilot merchant yet (see the companion business-plan memo's
  Phase 1/2). Test coverage is entirely against this sandbox's own mock merchant.
- **One line item per checkout session.** Quantity may be > 1, but arbitrary
  multi-SKU carts are not supported — this mirrors the rest of the sandbox's
  single-SKU order model (`OrderRecord.sku` is a single string) rather than
  inventing new `OrderStore` semantics for a proof-of-concept handler.
- **REST transport only.** No MCP, A2A, or Embedded Protocol bindings.
- **Checkout capability only.** No Cart, Order (webhooks), Identity Linking, or
  any extension beyond our own handler declaration.
- **No version negotiation.** The profile/session responses declare a single
  pinned `UCP_PROTOCOL_VERSION`; the spec's `supported_versions` / capability
  intersection algorithm is not implemented.
- **Placeholder namespace.** `com.agentic-payments.ham_settlement` is not
  registered anywhere — it's the vendor-namespace shape the spec requires,
  using this repo's own name as a stand-in domain.
- **No idempotency-key support** on the new routes (unlike `/buy`). A session
  id is single-use by construction (`complete` on anything but a `QUOTED`
  session is refused with `invalid_state`), which covers accidental double
  submission without a separate idempotency mechanism.

## 8. Relationship to HAM / x401 / the plain `/buy` flow

Nothing about mandate issuance changes. `AuthorizationService.issueIntentFromPresentation`
(x401) or `.issueIntent` (OIDC) still produce the same `IntentMandate`; this
responder is a third *consumer* of that Intent, alongside the plain `/buy` GET
route and the delegated wallet-demo flow — proof that the seam described in
`docs/X401-PROTOCOL.md` §7 ("x401 is an alternative identity source feeding the
same choke point") holds for a genuinely different counterparty and wire format,
not just a different transport for the same merchant.
