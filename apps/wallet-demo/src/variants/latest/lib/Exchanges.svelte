<script lang="ts">
  /**
   * The HTTP exchanges of one purchase, as the agent actually made them — not
   * a diagram of what should happen. Each row decodes the x401 and x402 header
   * it carried; expand a row for the decoded objects.
   */
  import { atomicUsd, short } from "./api";
  let { exchanges = [] }: { exchanges: any[] } = $props();
  let open = $state<number | undefined>(undefined);

  const tone = (s: number) => (s >= 200 && s < 300 ? "b-ok" : s === 401 || s === 402 ? "b-warn" : "b-bad");
  function label(e: any): string {
    const d = e.decoded ?? {};
    if (d.proofRequest && e.status === 401) return "PROOF-REQUEST · proof required";
    if (d.proofResult) return `PROOF-RESULT · ${d.proofResult.error}`;
    if (e.path?.endsWith("/x401/token")) return e.status === 200 ? "token exchange → Verification Token" : "token exchange refused";
    if (e.path?.endsWith("/x401-handoff")) return "handoff → request_uri";
    if (d.paymentRequired) return `PAYMENT-REQUIRED · ${atomicUsd(d.paymentRequired.accepts?.[0]?.amount)} USDC`;
    if (d.payment && e.status === 200) return "PAYMENT-SIGNATURE → receipt";
    return e.body?.error_description ?? e.body?.error ?? "";
  }
  function headerTags(e: any): string[] {
    const d = e.decoded ?? {};
    return [
      d.proofResponse ? `PROOF-RESPONSE: ${d.proofResponse.kind === "x401 Token Object" ? "token" : "artifact"}` : "",
      d.payment ? "PAYMENT-SIGNATURE" : "",
      d.paymentResponse ? "PAYMENT-RESPONSE" : "",
    ].filter(Boolean);
  }
</script>

{#if exchanges.length}
  <div class="ex">
    {#each exchanges as e, i}
      <button type="button" class="ex-row" onclick={() => (open = open === i ? undefined : i)} aria-expanded={open === i}>
        <span class="mono meth">{e.method}</span>
        <span class="mono path" title={e.path}>{e.path}</span>
        <span class="badge {tone(e.status)}">{e.status}</span>
        <span class="lbl">{label(e)}</span>
        {#each headerTags(e) as t}<span class="tag mono">{t}</span>{/each}
      </button>
      {#if open === i}
        <div class="ex-detail">
          {#if e.decoded?.proofRequest}
            {@const req = e.decoded.proofRequest.credential_requirements?.digital?.requests?.[0]?.request}
            <div class="kv">
              <span class="k">protocol</span><span class="mono">{e.decoded.proofRequest.credential_requirements?.digital?.requests?.[0]?.protocol}</span>
              {#if req?.claims}
                <span class="k">client_id</span><span class="mono">{req.claims.client_id}</span>
                <span class="k">aud</span><span class="mono">{req.claims.aud}</span>
                <span class="k">scope</span><span class="mono">{req.claims.scope}</span>
                <span class="k">nonce</span><span class="mono">{req.claims.nonce}</span>
                <span class="k">expected_origins</span><span class="mono">{(req.claims.expected_origins ?? []).join(", ")}</span>
                <span class="k">signed by</span><span class="mono">{req.header?.alg} · kid {short(req.header?.kid, 10, 6)}</span>
              {/if}
              {#if e.decoded.proofRequest.oauth}<span class="k">token_endpoint</span><span class="mono">{e.decoded.proofRequest.oauth.token_endpoint}</span>{/if}
              {#if e.decoded.proofRequest.payment}<span class="k">payment hint</span><span>{e.decoded.proofRequest.payment.scheme_hint} · {e.decoded.proofRequest.payment.notes}</span>{/if}
            </div>
          {/if}
          <pre class="mono">{JSON.stringify(e.decoded && Object.keys(e.decoded).length ? e.decoded : e.body, null, 2)}</pre>
        </div>
      {/if}
    {/each}
  </div>
{:else}
  <p class="mut" style="margin:0;font-size:12.5px">No requests yet — start a purchase.</p>
{/if}

<style>
  .ex { display: flex; flex-direction: column; gap: 4px; }
  .ex-row {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px; text-align: left; width: 100%;
    background: var(--chip); color: var(--ink); border: 1px solid var(--line); border-radius: 9px;
    padding: 7px 9px; font-weight: 500; font-size: 12px;
  }
  .ex-row:hover:not(:disabled) { filter: none; border-color: var(--acc); }
  .meth { color: var(--acc); font-weight: 700; min-width: 34px; }
  .path { color: var(--ink); max-width: 230px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lbl { color: var(--mut); flex: 1; min-width: 120px; }
  .tag { font-size: 10px; padding: 1px 6px; border-radius: 5px; background: rgba(138, 107, 255, 0.16); color: var(--acc2); }
  .ex-detail { border: 1px solid var(--line); border-top: 0; border-radius: 0 0 9px 9px; padding: 8px 10px; margin-top: -6px; background: var(--panel2); }
  .ex-detail pre { font-size: 11px; white-space: pre-wrap; word-break: break-all; max-height: 280px; overflow: auto; margin: 8px 0 0; }
</style>
