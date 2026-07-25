/**
 * A narrow, spec-shaped subset of the Universal Commerce Protocol (UCP) wire
 * format — just enough of the Checkout capability to expose a custom
 * `payment_handler` secured by a HAM Intent Mandate. Defined ONCE here so the
 * merchant responder and the agent client can never drift on the shape.
 *
 * Scope is deliberately narrow: REST transport only, Checkout capability only
 * (no Cart/Order/Identity-Linking, no MCP/A2A/Embedded transports, no version
 * negotiation algorithm). See docs/UCP-HANDLER.md for what's out of scope and
 * why. `HAM_SETTLEMENT_NAMESPACE` is a placeholder vendor namespace pending a
 * real registered domain.
 */
import { z } from "zod";
import { EvmAddress, PaymentPayload } from "./schemas.ts";

/** This sandbox's UCP protocol version (the one date-stamped example the spec itself uses). */
export const UCP_PROTOCOL_VERSION = "2026-04-08" as const;

/** Our custom payment_handler's namespace, id, and credential instrument type. */
export const HAM_SETTLEMENT_NAMESPACE = "com.agentic-payments.ham_settlement" as const;
export const HAM_SETTLEMENT_HANDLER_ID = "ham-settlement-v1" as const;
export const HAM_MANDATE_INSTRUMENT_TYPE = "ham_mandate" as const;

export const UcpLineItem = z.object({
  sku: z.string().min(1),
  quantity: z.number().int().positive(),
});
export type UcpLineItem = z.infer<typeof UcpLineItem>;

/** `POST /ucp/checkout-sessions` request body. */
export const UcpCheckoutRequest = z.object({
  line_items: z.array(UcpLineItem).min(1),
});
export type UcpCheckoutRequest = z.infer<typeof UcpCheckoutRequest>;

/** One entry in a business profile's `payment_handlers` map. */
export const UcpPaymentHandlerEntry = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  spec: z.string().url(),
  schema: z.string().url().optional(),
  available_instruments: z.array(z.object({ type: z.string().min(1) })).min(1),
});
export type UcpPaymentHandlerEntry = z.infer<typeof UcpPaymentHandlerEntry>;

/**
 * Everything an agent needs to construct a valid x402 `PaymentRequirements`
 * for this checkout session, computed ONCE by the merchant (via its own
 * `x402ResourceServer.buildPaymentRequirements`) and echoed back so the client
 * never has to independently know asset-specific EIP-712 domain trivia
 * (`extra.name`/`extra.version`) — it reads them from here instead.
 */
export const UcpSettlementInfo = z.object({
  asset: EvmAddress,
  network: z.string(),
  payTo: EvmAddress,
  extra: z.record(z.string(), z.unknown()),
});
export type UcpSettlementInfo = z.infer<typeof UcpSettlementInfo>;

/** The `dev.ucp.shopping.checkout` capability + our handler, as returned by create/get. */
export const UcpCheckoutSession = z.object({
  ucp: z.object({
    version: z.literal(UCP_PROTOCOL_VERSION),
    capabilities: z.record(z.string(), z.array(z.object({ version: z.string() }))),
  }),
  id: z.string().min(1),
  status: z.enum(["incomplete", "completed", "error"]),
  line_items: z.array(UcpLineItem),
  totals: z.object({
    total: z.object({
      amount: z.string(), // atomic units, decimal string (matches UintString elsewhere)
      currency: z.literal("USDC"),
    }),
  }),
  payment_handlers: z.record(z.string(), z.array(UcpPaymentHandlerEntry)),
  settlement: UcpSettlementInfo,
});
export type UcpCheckoutSession = z.infer<typeof UcpCheckoutSession>;

/**
 * Our custom credential: a HAM Intent Mandate (compact-signed JWT, produced by
 * the existing x401/OIDC identity seam unchanged) plus the signed x402 payment
 * it authorizes. Carried as the `credential` of one `payment.instruments[]`
 * entry whose `handler_id` matches `HAM_SETTLEMENT_HANDLER_ID`.
 */
export const HamMandateCredential = z.object({
  type: z.literal(HAM_MANDATE_INSTRUMENT_TYPE),
  intent: z.string().min(1), // compact-signed IntentMandate
  payment: PaymentPayload,
});
export type HamMandateCredential = z.infer<typeof HamMandateCredential>;

export const UcpPaymentInstrument = z.object({
  id: z.string().min(1),
  handler_id: z.string().min(1),
  type: z.literal(HAM_MANDATE_INSTRUMENT_TYPE),
  credential: HamMandateCredential,
});
export type UcpPaymentInstrument = z.infer<typeof UcpPaymentInstrument>;

/** `POST /ucp/checkout-sessions/:id/complete` request body. */
export const UcpCompleteCheckoutRequest = z.object({
  payment: z.object({
    instruments: z.array(UcpPaymentInstrument).min(1),
  }),
});
export type UcpCompleteCheckoutRequest = z.infer<typeof UcpCompleteCheckoutRequest>;

/** The spec's `{ type, code, content }` message shape — narrowed to our own codes. */
export const UcpMessage = z.object({
  type: z.enum(["error", "info"]),
  code: z.string().min(1),
  content: z.string(),
});
export type UcpMessage = z.infer<typeof UcpMessage>;

/** Error envelope for a failed negotiation/completion. */
export const UcpErrorResponse = z.object({
  ucp: z.object({ version: z.literal(UCP_PROTOCOL_VERSION), status: z.literal("error") }),
  messages: z.array(UcpMessage).min(1),
});
export type UcpErrorResponse = z.infer<typeof UcpErrorResponse>;

/** Minimal `/.well-known/ucp` business profile — just enough to publish our handler. */
export const UcpProfile = z.object({
  ucp: z.object({
    version: z.literal(UCP_PROTOCOL_VERSION),
    capabilities: z.record(z.string(), z.array(z.object({ version: z.string() }))),
    payment_handlers: z.record(z.string(), z.array(UcpPaymentHandlerEntry)),
  }),
});
export type UcpProfile = z.infer<typeof UcpProfile>;

/** Success envelope for `complete_checkout`. */
export const UcpCompleteCheckoutResponse = z.object({
  ucp: z.object({ version: z.literal(UCP_PROTOCOL_VERSION), status: z.literal("ok") }),
  id: z.string().min(1),
  status: z.literal("completed"),
  order: z.object({
    state: z.string(),
    txHash: z.string().optional(),
    pollUrl: z.string().optional(),
  }),
});
export type UcpCompleteCheckoutResponse = z.infer<typeof UcpCompleteCheckoutResponse>;
