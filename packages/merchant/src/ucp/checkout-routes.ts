/**
 * A UCP-shaped Checkout responder: `POST /checkout-sessions` (Negotiation +
 * pricing) and `POST /checkout-sessions/:id/complete` (Acquisition +
 * Completion, in one call). Reuses every existing seam unchanged — OrderStore,
 * MandateVerifier, RevocationChecker, SpendLedger, the Cart/Payment mandate
 * builders + validators, and the merchant's own x402ResourceServer — this file
 * only translates UCP's JSON wire shape onto that machinery. See
 * docs/UCP-HANDLER.md for the full wire shapes and explicit non-goals.
 *
 * Scope: exactly one line item per checkout session (quantity may be > 1),
 * mirroring the rest of this sandbox's single-SKU order model — see the doc
 * for why arbitrary multi-item carts are out of scope for this pass.
 */
import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { x402ResourceServer } from "@x402/core/server";
import {
  HAM_SETTLEMENT_HANDLER_ID,
  HAM_SETTLEMENT_NAMESPACE,
  HAM_MANDATE_INSTRUMENT_TYPE,
  UCP_PROTOCOL_VERSION,
  UcpCheckoutRequest,
  UcpCompleteCheckoutRequest,
  IntentMandate,
  atomicToDollars,
  nowSeconds,
  validateCartAgainstIntent,
  validatePayerAgainstIntent,
  validatePaymentAgainstCart,
  type PaymentRequirements,
  type UcpCheckoutSession,
} from "@agentic-payments/shared";
import {
  buildCartMandate,
  buildPaymentMandate,
  type MandateVerifier,
  type RevocationChecker,
} from "@agentic-payments/identity";
import { findProduct, productPriceAtomic } from "../catalog.ts";
import type { OrderStore } from "../order-store.ts";
import type { SpendLedger } from "../spend-ledger.ts";
import type { MerchantConfig } from "../config.ts";

export interface UcpCheckoutRouterOptions {
  orders: OrderStore;
  ledger: SpendLedger;
  mandateVerifier: MandateVerifier;
  revocation?: RevocationChecker;
  resourceServer: x402ResourceServer;
  config: MerchantConfig;
  /** Where this handler's human-readable spec is published (docs/UCP-HANDLER.md). */
  handlerSpecUrl: string;
  now?: () => number;
}

function ucpError(res: Response, status: number, code: string, content: string): void {
  res.status(status).json({
    ucp: { version: UCP_PROTOCOL_VERSION, status: "error" },
    messages: [{ type: "error", code, content }],
  });
}

export function createUcpCheckoutRouter(opts: UcpCheckoutRouterOptions): Router {
  const router = Router();
  const now = opts.now ?? nowSeconds;
  // Checkout-session id -> the one line item it was quoted for. The order
  // itself already tracks price/state via the existing OrderStore; this map
  // just remembers which catalog line the session's total came from so
  // completion can recompute the cart from the merchant's own catalog, never
  // from anything the request body claims.
  const sessionLineItem = new Map<string, { sku: string; quantity: number }>();
  // The exact PaymentRequirements quoted for a session (asset/network/extra —
  // including EIP-712 domain info for known assets like USDC), computed ONCE
  // via the SDK's own lookup and reused unchanged at completion, so verify/
  // settle never re-derive it and risk drifting from what was quoted.
  const sessionRequirements = new Map<string, PaymentRequirements>();

  router.post("/checkout-sessions", async (req: Request, res: Response) => {
    const parsed = UcpCheckoutRequest.safeParse(req.body);
    if (!parsed.success) {
      return ucpError(res, 400, "invalid_request", parsed.error.issues.map((i) => i.message).join("; "));
    }
    if (parsed.data.line_items.length !== 1) {
      return ucpError(
        res,
        400,
        "unsupported_cart",
        "this handler supports exactly one line item per checkout session",
      );
    }
    const li = parsed.data.line_items[0]!;
    const product = findProduct(li.sku);
    if (!product) return ucpError(res, 404, "unknown_sku", `unknown sku: ${li.sku}`);

    const total = productPriceAtomic(product.sku) * BigInt(li.quantity);
    const id = `ucp_ord_${randomUUID()}`;
    opts.orders.create({ id, sku: product.sku, amount: total.toString(), payTo: opts.config.payTo });
    opts.orders.transition(id, "QUOTED");
    sessionLineItem.set(id, { sku: product.sku, quantity: li.quantity });

    // Reuse the SDK's own money-parsing + known-asset lookup (the same path
    // buildRoutes()/paymentMiddleware uses for the plain /buy flow) instead of
    // hand-rolling EIP-712 domain info here.
    const [builtRequirements] = await opts.resourceServer.buildPaymentRequirements({
      scheme: "exact",
      payTo: opts.config.payTo,
      price: `$${atomicToDollars(total)}`,
      network: opts.config.network,
      maxTimeoutSeconds: 120,
    });
    if (!builtRequirements) {
      throw new Error("x402ResourceServer.buildPaymentRequirements returned no requirements for a single option");
    }
    const requirements = builtRequirements as unknown as PaymentRequirements;
    sessionRequirements.set(id, requirements);

    const session: UcpCheckoutSession = {
      ucp: {
        version: UCP_PROTOCOL_VERSION,
        capabilities: { "dev.ucp.shopping.checkout": [{ version: UCP_PROTOCOL_VERSION }] },
      },
      id,
      status: "incomplete",
      line_items: [{ sku: product.sku, quantity: li.quantity }],
      totals: { total: { amount: total.toString(), currency: "USDC" } },
      payment_handlers: {
        [HAM_SETTLEMENT_NAMESPACE]: [
          {
            id: HAM_SETTLEMENT_HANDLER_ID,
            version: UCP_PROTOCOL_VERSION,
            spec: opts.handlerSpecUrl,
            available_instruments: [{ type: HAM_MANDATE_INSTRUMENT_TYPE }],
          },
        ],
      },
      settlement: {
        asset: requirements.asset as `0x${string}`,
        network: requirements.network,
        payTo: requirements.payTo as `0x${string}`,
        extra: requirements.extra ?? {},
      },
    };
    res.json(session);
  });

  router.post("/checkout-sessions/:id/complete", async (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const order = opts.orders.get(id);
    const lineItem = sessionLineItem.get(id);
    if (!order || !lineItem) {
      return ucpError(res, 404, "unknown_checkout", `unknown checkout session: ${id}`);
    }
    if (order.state !== "QUOTED") {
      return ucpError(
        res,
        409,
        "invalid_state",
        `checkout session ${id} is not awaiting completion (state=${order.state})`,
      );
    }

    const parsed = UcpCompleteCheckoutRequest.safeParse(req.body);
    if (!parsed.success) {
      return ucpError(res, 400, "invalid_request", parsed.error.issues.map((i) => i.message).join("; "));
    }
    const instrument = parsed.data.payment.instruments.find(
      (i) => i.handler_id === HAM_SETTLEMENT_HANDLER_ID,
    );
    if (!instrument) {
      return ucpError(res, 400, "unsupported_handler", `no instrument for handler ${HAM_SETTLEMENT_HANDLER_ID}`);
    }

    let intent: IntentMandate;
    try {
      intent = IntentMandate.parse(
        JSON.parse(Buffer.from(instrument.credential.intent, "base64").toString("utf8")),
      );
    } catch {
      return ucpError(res, 400, "invalid_credential", "credential.intent is not a valid IntentMandate");
    }

    const sigOk = await opts.mandateVerifier.verifyProof(intent);
    if (!sigOk) {
      return ucpError(res, 403, "authorization_denied", "intent mandate signature is invalid or untrusted");
    }
    const revoked = opts.revocation ? await opts.revocation.isRevoked(intent.id) : false;
    if (revoked) {
      return ucpError(res, 403, "authorization_denied", "intent mandate has been revoked");
    }

    // Server-owned truth: the cart is rebuilt from the catalog + the line item
    // this session was quoted for, never from anything the agent submits here.
    const product = findProduct(lineItem.sku)!;
    const cart = buildCartMandate({
      intentId: intent.id,
      merchant: opts.config.payTo,
      items: [
        {
          sku: product.sku,
          name: product.name,
          category: product.category,
          unitPrice: productPriceAtomic(product.sku).toString(),
          quantity: lineItem.quantity,
        },
      ],
      nowSeconds: now(),
    });
    const cartScope = validateCartAgainstIntent(cart, intent, now());
    if (!cartScope.ok) {
      return ucpError(res, 403, "authorization_denied", cartScope.violations.join("; "));
    }

    const payment = instrument.credential.payment;
    const payerScope = validatePayerAgainstIntent(
      { address: payment.payload.authorization.from, network: opts.config.network },
      intent,
    );
    if (!payerScope.ok) {
      return ucpError(res, 403, "payer_agent_mismatch", payerScope.violations.join("; "));
    }

    const paymentMandate = buildPaymentMandate({
      cartId: cart.id,
      payTo: opts.config.payTo,
      asset: opts.config.asset,
      amount: payment.payload.authorization.value,
      network: opts.config.network,
      nonce: payment.payload.authorization.nonce,
    });
    const paymentScope = validatePaymentAgainstCart(paymentMandate, cart);
    if (!paymentScope.ok) {
      return ucpError(res, 403, "authorization_denied", paymentScope.violations.join("; "));
    }

    // Cumulative-cap reservation — same discipline as mandate-gate.ts: reserve
    // before settling, and pair every reserve with exactly one commit/release.
    const price = BigInt(cart.total);
    const reservation = await opts.ledger.reserve(
      intent.id,
      paymentMandate.nonce,
      price,
      BigInt(intent.scope.maxAmount),
    );
    if (!reservation.ok) {
      return ucpError(res, 403, "authorization_denied", reservation.violations.join("; "));
    }

    opts.orders.transition(id, "AUTHORIZED");

    // The exact requirements quoted at create_checkout time — never rebuilt
    // here, so verify/settle can't drift from what the agent was quoted.
    const requirements = sessionRequirements.get(id)!;

    // The SDK's own PaymentPayload type doesn't structurally unify with our
    // shared zod-inferred one (e.g. `resource` is `unknown|undefined` here vs
    // a narrower optional type there) — cast at this one boundary; `payment`
    // was already validated against our HamMandateCredential schema above.
    const sdkPayment = payment as unknown as Parameters<typeof opts.resourceServer.verifyPayment>[0];

    const verifyResult = await opts.resourceServer.verifyPayment(sdkPayment, requirements);
    if (!verifyResult.isValid) {
      await opts.ledger.release(paymentMandate.nonce);
      opts.orders.transition(id, "FAILED");
      return ucpError(res, 402, "payment_invalid", verifyResult.invalidReason ?? "payment verification failed");
    }

    opts.orders.transition(id, "SETTLING");
    const settleResult = await opts.resourceServer.settlePayment(sdkPayment, requirements);
    if (!settleResult.success) {
      await opts.ledger.release(paymentMandate.nonce);
      opts.orders.transition(id, "FAILED");
      return ucpError(res, 402, "settlement_failed", settleResult.errorReason ?? "settlement failed");
    }

    await opts.ledger.commit(paymentMandate.nonce);
    opts.orders.transition(id, "SETTLED");
    opts.orders.attachPayment(id, { nonce: paymentMandate.nonce, txHash: settleResult.transaction });

    res.json({
      ucp: { version: UCP_PROTOCOL_VERSION, status: "ok" },
      id,
      status: "completed",
      order: {
        state: "SETTLED",
        txHash: settleResult.transaction,
        // Unlike /buy (async settlement, only a nonce known up front), this
        // route settles synchronously and the session id IS the order id, so
        // polling can go straight through the plain /orders/:id route — no
        // need for the nonce->order indirection /buy relies on.
        pollUrl: `/orders/${id}`,
      },
    });
  });

  return router;
}
