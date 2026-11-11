/**
 * Mock-VeryGood-RX merchant server. Uses the official @x402/express middleware for
 * protocol-correct 402 challenge + verify + settle (via our resilient
 * facilitator), and layers an order ledger + HTTP-level idempotency around it.
 *
 * The x402 middleware grants access on `verify` and settles AFTER the response,
 * so the lifecycle maps as: verify -> order AUTHORIZED (synchronous, in the
 * route handler); settle success -> order SETTLED (asynchronous, via the
 * facilitator settle hook). Clients poll /orders/by-nonce/:nonce for the final
 * settled receipt + tx hash.
 *
 * Run: `npm run merchant`  (FACILITATOR_MODE=mock needs no key or funds).
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import { x402ResourceServer, type RoutesConfig } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware } from "@x402/express";
import { loadEnv } from "@agentic-payments/shared";
import { CATALOG, findProduct, productPriceAtomic } from "./catalog.ts";
import {
  assertConfigValid,
  loadMerchantConfig,
  type MerchantConfig,
} from "./config.ts";
import { buildFacilitator } from "./facilitator/index.ts";
import type { SettleHooks } from "./facilitator/resilient.ts";
import { MemoryOrderStore, type OrderStore } from "./order-store.ts";
import { createMandateGate } from "./mandate-gate.ts";
import { InMemorySpendLedger, type SpendLedger } from "./spend-ledger.ts";
import { decodePaymentAuthorization } from "./x402-headers.ts";
import { ucpProfileHandler } from "./ucp/profile.ts";
import { createUcpCheckoutRouter } from "./ucp/checkout-routes.ts";
import { X401_BUY_PREFIX, X401_TOKEN_PATH, createX401Gate } from "./x401/gate.ts";
import type { MandateVerifier, RevocationChecker } from "@agentic-payments/identity";
import type { X401VerifierV1 } from "@agentic-payments/credentials";

export * from "./spend-ledger.ts";
export { CATALOG, findProduct, productPriceAtomic, type Product } from "./catalog.ts";
export { basketFor, summarizeProof, X401_BUY_PREFIX, X401_TOKEN_PATH, type X401Authorization } from "./x401/gate.ts";
export { buildFacilitator, MockFacilitator } from "./facilitator/index.ts";

export interface MerchantAppOptions {
  /** When set, /buy requires a signed Human Authorization Mandate (Phase 2). */
  mandateVerifier?: MandateVerifier;
  /** When set, /buy also refuses any Intent the issuer has revoked. */
  revocation?: RevocationChecker;
  /** Spend-cap ledger; defaults to a per-process in-memory one. Inject a durable
   *  (file) or global (http) ledger for cross-restart / cross-merchant caps. */
  ledger?: SpendLedger;
  /**
   * UCP-shaped payment_handler responder (see packages/merchant/src/ucp/ +
   * docs/UCP-HANDLER.md). Off by default so the existing /buy behavior is
   * unaffected; requires mandateVerifier (the handler is HAM-secured only).
   */
  ucp?: { enabled: boolean; handlerSpecUrl?: string };
  /**
   * The latest x401 flow: the merchant is itself the verifier. When set,
   * `/x401/buy/:sku` answers 401 + PROOF-REQUEST, `/x401/token` exchanges a
   * Result Artifact for a Verification Token, and only then does the x402
   * paywall run. Off by default — `/buy` never changes.
   */
  x401?: {
    verifier: X401VerifierV1;
    merchantName?: string;
    sessionData?: boolean;
    tokenTtlSeconds?: number;
  };
}

const ORDER_HEADER = "idempotency-key";

/** Build the priced x402 routes from the catalog (one static route per sku). */
function buildRoutes(config: MerchantConfig, prefixes: string[] = ["/buy"]): RoutesConfig {
  const routes: Record<string, unknown> = {};
  for (const prefix of prefixes) {
    for (const p of CATALOG) {
      routes[`GET ${prefix}/${p.sku}`] = {
        accepts: {
          scheme: "exact",
          payTo: config.payTo,
          price: `$${p.priceUsd}`,
          network: config.network,
          maxTimeoutSeconds: 120,
        },
        description: p.name,
        mimeType: "application/json",
      };
    }
  }
  return routes as RoutesConfig;
}

export interface MerchantApp {
  app: express.Express;
  orders: OrderStore;
  config: MerchantConfig;
}

export function createMerchantApp(
  configOverride?: Partial<MerchantConfig>,
  options: MerchantAppOptions = {},
): MerchantApp {
  const config = { ...loadMerchantConfig(), ...configOverride };
  assertConfigValid(config);
  const orders = new MemoryOrderStore();
  const nonceToOrder = new Map<string, string>();
  // Default to an in-process ledger; the caller can inject a durable/global one.
  const ledger: SpendLedger = options.ledger ?? new InMemorySpendLedger();

  // When settlement resolves (after the response), advance the order. This is
  // where AUTHORIZED -> SETTLED (or -> FAILED) actually happens.
  const hooks: SettleHooks = {
    onSettleSuccess: async (nonce, res) => {
      await ledger.commit(nonce); // move reserved spend to committed (may be remote)
      const id = nonceToOrder.get(nonce.toLowerCase());
      const order = id ? orders.get(id) : undefined;
      if (!id || order?.state !== "AUTHORIZED") return;
      orders.transition(id, "SETTLING");
      orders.transition(id, "SETTLED");
      orders.attachPayment(id, { nonce, txHash: res.transaction });
    },
    onSettleFailure: async (nonce) => {
      await ledger.release(nonce); // free the cap reservation
      const id = nonceToOrder.get(nonce.toLowerCase());
      const order = id ? orders.get(id) : undefined;
      if (id && order?.state === "AUTHORIZED") orders.transition(id, "FAILED");
    },
  };

  const { resilient } = buildFacilitator(config, { hooks });
  const resourceServer = new x402ResourceServer(resilient);
  registerExactEvmScheme(resourceServer, { networks: [config.network] });

  const app = express();
  app.use(express.json());

  // --- Open routes (no payment required) ---
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, mode: config.facilitatorMode, network: config.network });
  });

  app.get("/catalog", (_req, res) => {
    res.json({ products: CATALOG, payTo: config.payTo, network: config.network });
  });

  app.get("/orders", (_req, res) => {
    res.json({ orders: orders.all().sort((a, b) => b.updatedAt - a.updatedAt) });
  });

  app.get("/orders/:id", (req, res) => {
    const order = orders.get(req.params.id ?? "");
    if (!order) return res.status(404).json({ error: "order not found" });
    res.json(order);
  });

  app.get("/orders/by-nonce/:nonce", (req, res) => {
    const id = nonceToOrder.get((req.params.nonce ?? "").toLowerCase());
    const order = id ? orders.get(id) : undefined;
    if (!order) return res.status(404).json({ error: "order not found" });
    res.json(order);
  });

  // --- Idempotency guard: a replayed checkout under the same key returns the
  // existing (already-authorized/settled) order and never re-enters payment,
  // so a retried purchase can't double-charge. ---
  app.use("/buy", (req, res, next) => {
    const key = req.header(ORDER_HEADER);
    if (!key) return next();
    const existing = orders.findByIdempotencyKey(key);
    if (existing && existing.state !== "CREATED" && existing.state !== "QUOTED") {
      return res.json({ replayed: true, order: existing });
    }
    next();
  });

  // --- Human Authorization Mandate gate (Phase 2): when a verifier is
  // configured, every /buy must carry a signed, in-scope Intent mandate. ---
  if (options.mandateVerifier) {
    app.use(
      "/buy",
      createMandateGate({
        verifier: options.mandateVerifier,
        merchant: config.payTo,
        asset: config.asset,
        network: config.network,
        ledger,
        ...(options.revocation ? { revocation: options.revocation } : {}),
      }),
    );
  }

  // --- Latest x401 gate (opt-in): proof first, then the same x402 paywall ---
  if (options.x401) {
    const { gate, tokenEndpoint } = createX401Gate({
      verifier: options.x401.verifier,
      merchantName: options.x401.merchantName ?? "Mock VeryGood-RX",
      network: config.network as `eip155:${number}`,
      ledger,
      ...(options.x401.sessionData !== undefined ? { sessionData: options.x401.sessionData } : {}),
      ...(options.x401.tokenTtlSeconds !== undefined ? { tokenTtlSeconds: options.x401.tokenTtlSeconds } : {}),
    });
    app.post(X401_TOKEN_PATH, express.urlencoded({ extended: false }), tokenEndpoint);
    app.use(X401_BUY_PREFIX, (req, res, next) => {
      // Same replay guard as /buy: a retried purchase never re-enters payment.
      const key = req.header(ORDER_HEADER);
      const existing = key ? orders.findByIdempotencyKey(key) : undefined;
      if (existing && existing.state !== "CREATED" && existing.state !== "QUOTED") {
        return res.json({ replayed: true, order: existing });
      }
      next();
    });
    app.use(X401_BUY_PREFIX, gate);
  }

  // --- The x402 paywall: challenges with 402, verifies on retry ---
  app.use(paymentMiddleware(buildRoutes(config, options.x401 ? ["/buy", X401_BUY_PREFIX] : ["/buy"]), resourceServer));

  // --- Fulfilment: runs after the payment verifies (settlement is async) ---
  const fulfil = (req: Request, res: Response) => {
    const product = findProduct(req.params.sku ?? "");
    if (!product) return res.status(404).json({ error: "unknown sku" });

    const nonce = decodePaymentAuthorization(req).nonce ?? "";
    const id = `ord_${nonce || randomUUID()}`;
    if (!orders.get(id)) {
      orders.create({
        id,
        sku: product.sku,
        amount: productPriceAtomic(product.sku).toString(),
        payTo: config.payTo,
        idempotencyKey: req.header(ORDER_HEADER),
      });
      orders.transition(id, "QUOTED");
      orders.transition(id, "AUTHORIZED");
      if (nonce) {
        orders.attachPayment(id, { nonce });
        nonceToOrder.set(nonce.toLowerCase(), id);
      }
    }
    const order = orders.get(id)!;

    res.json({
      receipt: {
        orderId: order.id,
        product: { sku: product.sku, name: product.name },
        amountUsd: product.priceUsd,
        network: config.network,
        state: order.state, // AUTHORIZED now; SETTLED after async settlement
        paymentNonce: nonce || undefined,
        settlement: "pending",
        pollUrl: nonce ? `/orders/by-nonce/${nonce}` : undefined,
        // How the latest flow authorized it (who, under which proof); absent on /buy.
        ...(res.locals.x401 ? { authorization: res.locals.x401 } : {}),
      },
    });
  };
  app.get("/buy/:sku", fulfil);
  if (options.x401) app.get(`${X401_BUY_PREFIX}/:sku`, fulfil);

  // --- UCP-shaped payment_handler responder (opt-in, HAM-secured only) ---
  // options.ucp overrides UCP_MERCHANT_ENABLED (tests force it on regardless
  // of env; the standalone `npm run merchant` process is env-driven).
  const ucpEnabled = options.ucp?.enabled ?? config.ucpEnabled;
  if (ucpEnabled) {
    if (!options.mandateVerifier) {
      throw new Error("options.ucp.enabled requires options.mandateVerifier — the handler is HAM-secured only");
    }
    const handlerSpecUrl = options.ucp?.handlerSpecUrl ?? "https://example.com/docs/UCP-HANDLER.md";
    app.get("/.well-known/ucp", ucpProfileHandler({ handlerSpecUrl }));
    app.use(
      "/ucp",
      createUcpCheckoutRouter({
        orders,
        ledger,
        mandateVerifier: options.mandateVerifier,
        ...(options.revocation ? { revocation: options.revocation } : {}),
        resourceServer,
        config,
        handlerSpecUrl,
      }),
    );
  }

  return { app, orders, config };
}

// Boot only when this file is the process entry point (not when imported).
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  loadEnv();
  const { app, config } = createMerchantApp();
  app.listen(config.port, () => {
    console.log(
      `[mock-VeryGood-RX] listening on :${config.port} ` +
        `(facilitator=${config.facilitatorMode}, network=${config.network})`,
    );
  });
}
