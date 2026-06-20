/**
 * Zod schemas for the x402 v2 payment wire types. Defined ONCE here and
 * imported by merchant + agent so a payment shape can never drift between the
 * two sides. These mirror the `@x402/core` v2 types so a real library payload
 * parses cleanly through them (our validators are defense-in-depth on the
 * exact-scheme EIP-3009 authorization).
 */
import { z } from "zod";
import { PAYMENT_SCHEME, X402_NETWORK, X402_VERSION } from "./constants.ts";

/** 0x-prefixed 40-hex EVM address, normalized to lowercase. */
export const EvmAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "invalid EVM address")
  .transform((s) => s.toLowerCase() as `0x${string}`);

/** A stringified non-negative integer (atomic token units or unix seconds). */
export const UintString = z
  .string()
  .regex(/^\d+$/, "expected a non-negative integer string");

/** 0x-prefixed hex blob (signatures, 32-byte nonces). */
export const HexString = z
  .string()
  .regex(/^0x[0-9a-fA-F]+$/, "expected 0x-prefixed hex");

/**
 * A single accepted-payment option (v2 `PaymentRequirements`). The exact scheme
 * requires the payer to authorize exactly `amount` units to `payTo`.
 */
export const PaymentRequirements = z.object({
  scheme: z.literal(PAYMENT_SCHEME),
  network: z.literal(X402_NETWORK),
  asset: EvmAddress, // token contract (USDC)
  amount: UintString, // atomic USDC units
  payTo: EvmAddress, // merchant receiving address
  maxTimeoutSeconds: z.number().int().positive().default(120),
  extra: z.record(z.string(), z.unknown()).default({}),
});
export type PaymentRequirements = z.infer<typeof PaymentRequirements>;

/** The 402 envelope (v2 `PaymentRequired`): acceptable ways to pay. */
export const PaymentRequiredResponse = z.object({
  x402Version: z.literal(X402_VERSION),
  error: z.string().optional(),
  resource: z.unknown().optional(), // ResourceInfo in the library
  accepts: z.array(PaymentRequirements).min(1),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
export type PaymentRequiredResponse = z.infer<typeof PaymentRequiredResponse>;

/** EIP-3009 authorization the payer signs (the exact-scheme payload core). */
export const ExactEvmAuthorization = z.object({
  from: EvmAddress,
  to: EvmAddress,
  value: UintString, // atomic USDC units
  validAfter: UintString, // unix seconds (inclusive lower bound)
  validBefore: UintString, // unix seconds (exclusive upper bound)
  nonce: HexString, // 32-byte random nonce -> replay protection
});
export type ExactEvmAuthorization = z.infer<typeof ExactEvmAuthorization>;

/** The scheme-specific `payload` for the exact EVM (EIP-3009) scheme. */
export const ExactEvmPayload = z.object({
  signature: HexString.optional(),
  authorization: ExactEvmAuthorization,
});
export type ExactEvmPayload = z.infer<typeof ExactEvmPayload>;

/**
 * The decoded payment a payer submits to retry a 402'd request (v2
 * `PaymentPayload`). `accepted` (the chosen requirements echoed back) is part
 * of the library shape but optional for our validators, which take the
 * merchant's requirements as a separate argument.
 */
export const PaymentPayload = z.object({
  x402Version: z.literal(X402_VERSION),
  accepted: PaymentRequirements.optional(),
  payload: ExactEvmPayload,
  resource: z.unknown().optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
export type PaymentPayload = z.infer<typeof PaymentPayload>;
