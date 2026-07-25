/**
 * Agent-side client for the UCP-shaped checkout responder in
 * packages/merchant/src/ucp/. One real HTTP-speaking implementation — this
 * `live/` module doesn't carry its own local/mock split the way the identity,
 * facilitator, and ledger seams do (see .claude/skills/swappable-seams), since
 * HTTP+JSON is already cheap to fake with a real listener: point `baseUrl` at
 * this sandbox's own mock merchant in tests, or at a real UCP business later.
 *
 * `signUcpPayment` builds a signed x402 PaymentPayload directly — via
 * `x402Client.createPaymentPayload`, the same primitive `@x402/fetch`'s
 * `wrapFetchWithPayment` calls internally on a real 402 — so the caller never
 * needs an actual 402 challenge/response round trip just to get a signature.
 */
import {
  HAM_MANDATE_INSTRUMENT_TYPE,
  HAM_SETTLEMENT_NAMESPACE,
  X402_NETWORK,
  X402_VERSION,
  type PaymentPayload,
  type PaymentRequirements,
  type PaymentSigner,
  type UcpCheckoutSession,
  type UcpCompleteCheckoutResponse,
  type UcpErrorResponse,
  type UcpSettlementInfo,
} from "@agentic-payments/shared";
import { x402Client } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

export interface UcpCheckoutQuote {
  checkoutId: string;
  handlerId: string;
  total: { amount: string; currency: string };
  /** Asset/network/payTo/EIP-712 domain info — see `requirementsFromQuote`. */
  settlement: UcpSettlementInfo;
  raw: UcpCheckoutSession;
}

/**
 * Turns a quote's `settlement` block into the `PaymentRequirements` to sign
 * against — the agent never needs to independently know asset-specific
 * EIP-712 domain trivia; it reads exactly what the merchant quoted.
 */
export function requirementsFromQuote(quote: UcpCheckoutQuote): PaymentRequirements {
  return {
    scheme: "exact",
    // This sandbox only ever quotes its own network; the wire field is a
    // plain string so a real (non-sandbox) UCP business isn't forced onto
    // our literal network type.
    network: quote.settlement.network as PaymentRequirements["network"],
    asset: quote.settlement.asset,
    amount: quote.total.amount,
    payTo: quote.settlement.payTo,
    maxTimeoutSeconds: 120,
    extra: quote.settlement.extra,
  };
}

export class UcpCheckoutError extends Error {
  constructor(readonly response: UcpErrorResponse) {
    super(response.messages.map((m) => `${m.code}: ${m.content}`).join("; "));
    this.name = "UcpCheckoutError";
  }
}

export interface UcpCheckoutClientOptions {
  /** The merchant's base URL (e.g. `http://127.0.0.1:PORT`, no trailing slash needed). */
  baseUrl: string;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
}

export interface UcpCompleteCheckoutInput {
  /**
   * The EXACT quote `createCheckout` returned — never a re-derived total.
   * Defense-in-depth terms pinning, mirroring `live/guard.ts`'s
   * preflight-then-pinned discipline; the merchant separately recomputes the
   * cart from its own catalog, so this is belt-and-braces, not the only guard.
   */
  quote: UcpCheckoutQuote;
  /** Compact base64(JSON) IntentMandate — same encoding as the x-authorization-mandate header. */
  intent: string;
  /** A signed x402 payment for the quote's total (see `signUcpPayment`). */
  payment: PaymentPayload;
}

export interface UcpCheckoutClient {
  createCheckout(input: { lineItems: { sku: string; quantity: number }[] }): Promise<UcpCheckoutQuote>;
  completeCheckout(input: UcpCompleteCheckoutInput): Promise<UcpCompleteCheckoutResponse>;
}

async function readJson(res: Response): Promise<unknown> {
  return res.json().catch(() => ({}));
}

export function createUcpCheckoutClient(opts: UcpCheckoutClientOptions): UcpCheckoutClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, "");

  return {
    async createCheckout(input): Promise<UcpCheckoutQuote> {
      const res = await doFetch(`${base}/ucp/checkout-sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ line_items: input.lineItems }),
      });
      const body = await readJson(res);
      if (!res.ok) throw new UcpCheckoutError(body as UcpErrorResponse);
      const session = body as UcpCheckoutSession;
      const handlerEntry = session.payment_handlers[HAM_SETTLEMENT_NAMESPACE]?.[0];
      if (!handlerEntry) {
        throw new Error(`merchant did not offer the ${HAM_SETTLEMENT_NAMESPACE} handler`);
      }
      return {
        checkoutId: session.id,
        handlerId: handlerEntry.id,
        total: session.totals.total,
        settlement: session.settlement,
        raw: session,
      };
    },

    async completeCheckout(input): Promise<UcpCompleteCheckoutResponse> {
      const res = await doFetch(`${base}/ucp/checkout-sessions/${input.quote.checkoutId}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          payment: {
            instruments: [
              {
                id: "pm_1",
                handler_id: input.quote.handlerId,
                type: HAM_MANDATE_INSTRUMENT_TYPE,
                credential: {
                  type: HAM_MANDATE_INSTRUMENT_TYPE,
                  intent: input.intent,
                  payment: input.payment,
                },
              },
            ],
          },
        }),
      });
      const body = await readJson(res);
      if (!res.ok) throw new UcpCheckoutError(body as UcpErrorResponse);
      return body as UcpCompleteCheckoutResponse;
    },
  };
}

export interface SignUcpPaymentOptions {
  network?: `${string}:${string}`;
  rpcUrl?: string;
}

/**
 * Builds a signed x402 PaymentPayload for the given requirements, without an
 * actual 402 challenge round trip — `x402Client.createPaymentPayload` is the
 * same primitive `wrapFetchWithPayment` (packages/agent/src/x402-client.ts)
 * calls internally once it has decoded a real 402 response into a
 * `PaymentRequired` envelope; here we build that envelope ourselves from a
 * quote's total instead of parsing one off the wire.
 */
export async function signUcpPayment(
  signer: PaymentSigner,
  requirements: PaymentRequirements,
  opts: SignUcpPaymentOptions = {},
): Promise<PaymentPayload> {
  const account = await signer.getAccount();
  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: account as never,
    networks: [opts.network ?? X402_NETWORK],
    ...(opts.rpcUrl ? { schemeOptions: { rpcUrl: opts.rpcUrl } } : {}),
  });
  // The SDK's own PaymentRequired/PaymentPayload types don't structurally unify
  // with our shared zod-inferred ones (e.g. `resource` is required there,
  // optional-unknown here) — cast at this one boundary; the shape itself is
  // exactly what the SDK produces from `accepts`, which our `requirements`
  // satisfies field-for-field.
  const paymentRequired = {
    x402Version: X402_VERSION,
    resource: { url: "urn:agentic-payments:ucp-checkout" },
    accepts: [requirements],
  } as unknown as Parameters<typeof client.createPaymentPayload>[0];
  const payload = await client.createPaymentPayload(paymentRequired);
  return payload as unknown as PaymentPayload;
}
