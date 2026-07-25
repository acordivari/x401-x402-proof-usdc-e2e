/**
 * End-to-end: the UCP-shaped checkout responder (packages/merchant/src/ucp/)
 * enforces the same Human Authorization Mandate as the plain /buy flow, over
 * a JSON create/complete-checkout wire format instead of GET+headers. Mirrors
 * test/e2e-mandate.test.ts's coverage; see docs/UCP-HANDLER.md for scope.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createMerchantApp, type MerchantApp } from "@agentic-payments/merchant";
import {
  createLocalSigner,
  createUcpCheckoutClient,
  requirementsFromQuote,
  signUcpPayment,
  UcpCheckoutError,
  type PaymentSigner,
  type UcpCheckoutClient,
} from "@agentic-payments/agent";
import {
  AuthorizationService,
  createSigningKeyPair,
  LocalOidcIssuer,
  localVerifier,
  MandateSigner,
  MandateVerifier,
  RevocationRegistry,
  type IntentMandate,
  type SigningKeyPair,
} from "@agentic-payments/identity";

const MERCHANT = "0x2222222222222222222222222222222222222222" as const;

let merchant: MerchantApp;
let server: Server;
let base: string;
let client: UcpCheckoutClient;
let asKey: SigningKeyPair;
let issuer: LocalOidcIssuer;
let service: AuthorizationService;
let revocations: RevocationRegistry;

beforeAll(async () => {
  asKey = await createSigningKeyPair("auth-service-ucp-1");
  const oidcKey = await createSigningKeyPair("oidc-ucp-1");
  issuer = new LocalOidcIssuer("https://sandbox.local/", "agentic-payments", oidcKey);
  revocations = new RevocationRegistry();
  service = new AuthorizationService(
    localVerifier(issuer),
    new MandateSigner(asKey),
    undefined,
    revocations,
  );

  const mandateVerifier = new MandateVerifier([{ kid: asKey.kid, publicKey: asKey.publicKey }]);
  merchant = createMerchantApp(
    { facilitatorMode: "mock", payTo: MERCHANT },
    { mandateVerifier, revocation: revocations, ucp: { enabled: true } },
  );
  await new Promise<void>((resolve) => {
    server = merchant.app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  client = createUcpCheckoutClient({ baseUrl: base });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function issueIntentFor(
  agentWallet: `0x${string}`,
  opts: { maxAmount: string; categories: string[] },
): Promise<IntentMandate> {
  const idToken = await issuer.mintIdToken({
    sub: "auth0|ucp-buyer",
    email: "ucp-buyer@example.com",
    emailVerified: true,
  });
  return service.issueIntent({
    idToken,
    agentWallet,
    scope: {
      maxAmount: opts.maxAmount,
      merchantAllowlist: [MERCHANT],
      allowedCategories: opts.categories,
    },
  });
}

function encodeIntent(intent: IntentMandate): string {
  return Buffer.from(JSON.stringify(intent)).toString("base64");
}

/** Quote a sku, sign an x402 payment for the quoted total, and complete. */
async function checkout(
  signer: PaymentSigner,
  sku: string,
  intentB64: string,
  quantity = 1,
): Promise<{ ok: true; state: string } | { ok: false; status: string; message: string }> {
  const quote = await client.createCheckout({ lineItems: [{ sku, quantity }] });
  const payment = await signUcpPayment(signer, requirementsFromQuote(quote));
  try {
    const result = await client.completeCheckout({ quote, intent: intentB64, payment });
    return { ok: true, state: result.order.state };
  } catch (err) {
    if (err instanceof UcpCheckoutError) {
      const first = err.response.messages[0]!;
      return { ok: false, status: first.code, message: err.message };
    }
    throw err;
  }
}

async function pollSettled(pollUrl: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`${base}${pollUrl}`);
    if (r.ok) {
      const order = (await r.json()) as { state: string };
      if (order.state === "SETTLED" || order.state === "FAILED") return order.state;
    }
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("did not settle");
}

describe("UCP checkout responder enforces the Human Authorization Mandate", () => {
  it("negotiates and completes a purchase within the signed scope", async () => {
    const signer = createLocalSigner();
    const intent = await issueIntentFor(signer.address, {
      maxAmount: "5000000",
      categories: ["otc-medicine", "vitamins"],
    });
    const quote = await client.createCheckout({ lineItems: [{ sku: "allergy-relief-24", quantity: 1 }] });
    expect(quote.total.amount).toBe("1500000"); // $1.50 atomic
    expect(quote.handlerId).toBe("ham-settlement-v1");

    const payment = await signUcpPayment(signer, requirementsFromQuote(quote));
    const result = await client.completeCheckout({ quote, intent: encodeIntent(intent), payment });
    expect(result.status).toBe("completed");
    expect(result.order.pollUrl).toBeDefined();
    expect(await pollSettled(result.order.pollUrl!)).toBe("SETTLED");
  });

  it("rejects an instrument for an unsupported handler (400)", async () => {
    const signer = createLocalSigner();
    const intent = await issueIntentFor(signer.address, {
      maxAmount: "5000000",
      categories: ["otc-medicine"],
    });
    const quote = await client.createCheckout({ lineItems: [{ sku: "allergy-relief-24", quantity: 1 }] });
    // A well-formed signed payment, but addressed to a handler this merchant
    // never offered — must be refused before any mandate/payment checks run.
    const payment = await signUcpPayment(signer, requirementsFromQuote(quote));
    const res = await fetch(`${base}/ucp/checkout-sessions/${quote.checkoutId}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payment: {
          instruments: [
            {
              id: "pm_1",
              handler_id: "some-other-handler",
              type: "ham_mandate",
              credential: { type: "ham_mandate", intent: encodeIntent(intent), payment },
            },
          ],
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { messages: Array<{ code: string }> };
    expect(body.messages[0]!.code).toBe("unsupported_handler");
  });

  it("rejects a malformed credential.intent (400)", async () => {
    const signer = createLocalSigner();
    const { ok, status } = await checkout(signer, "allergy-relief-24", Buffer.from("not json").toString("base64"));
    expect(ok).toBe(false);
    expect(status).toBe("invalid_credential");
  });

  it("rejects a category outside the authorized scope (403)", async () => {
    const signer = createLocalSigner();
    const intent = await issueIntentFor(signer.address, {
      maxAmount: "5000000",
      categories: ["vitamins"], // allergy-relief is otc-medicine
    });
    const { ok, status, message } = await checkout(signer, "allergy-relief-24", encodeIntent(intent));
    expect(ok).toBe(false);
    expect(status).toBe("authorization_denied");
    expect(message).toMatch(/not authorized/);
  });

  it("rejects a purchase over the per-intent cap (403)", async () => {
    const signer = createLocalSigner();
    const intent = await issueIntentFor(signer.address, {
      maxAmount: "1000000", // $1.00 cap, allergy-relief is $1.50
      categories: ["otc-medicine"],
    });
    const { ok, status, message } = await checkout(signer, "allergy-relief-24", encodeIntent(intent));
    expect(ok).toBe(false);
    expect(status).toBe("authorization_denied");
    expect(message).toMatch(/exceeds? intent cap/);
  });

  it("rejects a tampered Intent (bad signature, 403)", async () => {
    const signer = createLocalSigner();
    const intent = await issueIntentFor(signer.address, {
      maxAmount: "1000000",
      categories: ["otc-medicine"],
    });
    const tampered = { ...intent, scope: { ...intent.scope, maxAmount: "9999999999" } };
    const { ok, status, message } = await checkout(signer, "allergy-relief-24", encodeIntent(tampered));
    expect(ok).toBe(false);
    expect(status).toBe("authorization_denied");
    expect(message).toMatch(/signature is invalid/);
  });

  it("rejects a payer that is not the bound agent (payer_agent_mismatch, 403)", async () => {
    const authorized = createLocalSigner();
    const rogue = createLocalSigner();
    const intent = await issueIntentFor(authorized.address, {
      maxAmount: "5000000",
      categories: ["otc-medicine"],
    });
    // The rogue wallet signs the x402 payment — but the mandate authorized a
    // different agent wallet.
    const { ok, status } = await checkout(rogue, "allergy-relief-24", encodeIntent(intent));
    expect(ok).toBe(false);
    expect(status).toBe("payer_agent_mismatch");
  });

  it("enforces the cumulative cap across multiple checkout sessions", async () => {
    const signer = createLocalSigner();
    const intent = await issueIntentFor(signer.address, {
      maxAmount: "3500000", // $3.50 total
      categories: ["otc-medicine", "vitamins"],
    });
    const encoded = encodeIntent(intent);

    // First: $2.25 vitamin — settles.
    const first = await checkout(signer, "vitamin-d3-2000", encoded);
    expect(first.ok).toBe(true);

    // Second: $1.50 allergy — cumulative $3.75 > $3.50 cap — rejected.
    const second = await checkout(signer, "allergy-relief-24", encoded);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.status).toBe("authorization_denied");
      expect(second.message).toMatch(/exceed intent cap/);
    }
  });

  it("refuses a revoked Intent even though it is otherwise valid (403)", async () => {
    const signer = createLocalSigner();
    const intent = await issueIntentFor(signer.address, {
      maxAmount: "5000000",
      categories: ["otc-medicine"],
    });
    service.revokeIntent(intent.id, "test revocation");
    const { ok, status, message } = await checkout(signer, "allergy-relief-24", encodeIntent(intent));
    expect(ok).toBe(false);
    expect(status).toBe("authorization_denied");
    expect(message).toMatch(/revoked/);
  });
});
