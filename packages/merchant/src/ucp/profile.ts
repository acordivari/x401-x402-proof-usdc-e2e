/**
 * `GET /.well-known/ucp` — the business profile. Pure metadata, no auth: it
 * declares the (narrow) Checkout capability this sandbox supports and
 * publishes our custom payment_handler (HAM_SETTLEMENT_NAMESPACE) alongside
 * where card/wallet handlers would normally sit (Shop Pay, Google Pay, etc.
 * in a real UCP business profile). See docs/UCP-HANDLER.md for scope.
 */
import type { Request, Response } from "express";
import {
  HAM_MANDATE_INSTRUMENT_TYPE,
  HAM_SETTLEMENT_HANDLER_ID,
  HAM_SETTLEMENT_NAMESPACE,
  UCP_PROTOCOL_VERSION,
  type UcpProfile,
} from "@agentic-payments/shared";

export interface UcpProfileOptions {
  /** Where this handler's human-readable spec is published (docs/UCP-HANDLER.md). */
  handlerSpecUrl: string;
}

export function ucpProfileHandler(opts: UcpProfileOptions) {
  return (_req: Request, res: Response): void => {
    const profile: UcpProfile = {
      ucp: {
        version: UCP_PROTOCOL_VERSION,
        capabilities: {
          "dev.ucp.shopping.checkout": [{ version: UCP_PROTOCOL_VERSION }],
        },
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
      },
    };
    // Profiles are meant to be shared-cacheable per the spec (min 60s TTL).
    res.set("Cache-Control", "public, max-age=60");
    res.json(profile);
  };
}
