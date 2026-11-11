<script lang="ts">
  /**
   * The wallet's consent screen. One component for all three places a person
   * says yes: the in-page demo wallet, the (emulated) Proof Cloud Wallet page a
   * handoff link opens, and granting a standing mandate. What it shows is what
   * the signature will cover — the verifier as authenticated from its own
   * metadata, exactly which claims leave the wallet, and the terms verbatim.
   */
  import { TEMPLATE_LABEL, fmtClaim, leaves, short, usd } from "./api";

  type Check = { label: string; ok: boolean; detail?: string };
  let {
    walletLabel,
    verifierName,
    clientId,
    checks = [],
    held,
    disclose = [],
    terms = [],
    mandate,
    billing,
    busy = false,
    approveLabel = "Approve & present",
    choosable = false,
    onapprove,
    ondecline,
  }: {
    walletLabel: string;
    verifierName?: string;
    clientId?: string;
    checks?: Check[];
    held?: Record<string, unknown>;
    /** Dotted claim paths that will be disclosed. */
    disclose?: string[];
    terms?: { type: string; payload: any }[];
    mandate?: { agent: { id: string; kid: string }; constraints: any[]; validitySeconds: number };
    billing?: "x402" | "account";
    busy?: boolean;
    approveLabel?: string;
    /** Let the person pick which claims travel (delegation). */
    choosable?: boolean;
    onapprove: (chosen: string[]) => void;
    ondecline?: () => void;
  } = $props();

  const heldLeaves = $derived(leaves(held ?? {}));
  let picked = $state<string[]>([]);
  // Seed the picker once; later prop refreshes (the parent polls) must not undo a choice.
  let seeded = false;
  $effect(() => {
    if (choosable && !seeded) { picked = [...disclose]; seeded = true; }
  });
  const shown = $derived(choosable ? picked : disclose);
  const sharedLeaves = $derived(heldLeaves.filter(([k]) => shown.includes(k)));
  const withheldLeaves = $derived(heldLeaves.filter(([k]) => !shown.includes(k)));
  const missing = $derived(shown.filter((p) => !heldLeaves.some(([k]) => k === p)));
  const allOk = $derived(checks.every((c) => c.ok));

  const toggle = (k: string) => (picked = picked.includes(k) ? picked.filter((x) => x !== k) : [...picked, k]);
  const itemsTotal = (p: any) => (p?.items ?? []).reduce((s: number, i: any) => s + i.quantity * i.unit_cost, 0);
  const constraintText = (c: any): string => {
    switch (c.type) {
      case "mandate.payment.budget": return `at most ${usd(c.max)} ${c.currency} in total`;
      case "mandate.payment.amount_range": return `at most ${usd(c.max)} per purchase`;
      case "mandate.payment.allowed_payees": return `only at ${c.payees.map((p: any) => p.name).join(", ")}`;
      case "x-agentic-payments.allowed_categories": return `only ${c.categories.join(", ")}`;
      default: return c.type;
    }
  };
</script>

<div class="sheet fade-in">
  <div class="sheet-head">
    <span class="wallet-mark">◈</span>
    <div>
      <div class="wl">{walletLabel}</div>
      <div class="mut" style="font-size:12px">
        <b style="color:var(--ink)">{verifierName ?? "A verifier"}</b> is asking
        {#if clientId}<span class="mono" title={clientId}> · {short(clientId, 22, 26)}</span>{/if}
      </div>
    </div>
  </div>

  {#if checks.length}
    <div class="checks">
      {#each checks as c}
        <span class="badge {c.ok ? 'b-ok' : 'b-bad'}" title={c.detail ?? ""}>{c.ok ? "✓" : "✗"} {c.label}</span>
      {/each}
    </div>
  {/if}

  <div class="sec">
    <div class="sec-h">{mandate ? "Travels with the mandate" : "You'll share"}</div>
    {#if choosable}
      <div class="row" style="gap:6px">
        {#each heldLeaves as [k, v]}
          <button type="button" class="chip-claim {picked.includes(k) ? 'on' : ''}" onclick={() => toggle(k)}>{k}: <b>{fmtClaim(v)}</b></button>
        {/each}
      </div>
    {:else}
      <div class="row" style="gap:6px">
        {#each sharedLeaves as [k, v]}<span class="chip-claim claim-disclosed">{k}: <b>{fmtClaim(v)}</b></span>{/each}
        {#each missing as k}<span class="chip-claim" style="border-color:var(--warn);color:var(--warn)">{k} (not held)</span>{/each}
      </div>
    {/if}
    {#if withheldLeaves.length}
      <div class="mut" style="font-size:11.5px;margin:8px 0 4px">Stays in the wallet (salted hashes only):</div>
      <div class="row" style="gap:6px">{#each withheldLeaves as [k]}<span class="chip-claim claim-withheld">{k}</span>{/each}</div>
    {/if}
  </div>

  {#if terms.length}
    <div class="sec">
      <div class="sec-h">You're signing</div>
      {#each terms as t}
        <div class="term">
          <div class="term-h"><span class="badge b-mut">{TEMPLATE_LABEL[t.type] ?? t.type}</span><span class="mono mut" style="font-size:10.5px">{t.type.split(":").slice(-2).join(":")}</span></div>
          {#if t.type.endsWith("payment-itemized:v1")}
            <table>
              <tbody>
                {#each t.payload.items as it}<tr><td>{it.quantity} ×</td><td>{it.label}</td><td style="text-align:right">{usd(it.unit_cost)}</td></tr>{/each}
                <tr><td></td><td><b>Total</b></td><td style="text-align:right"><b>{usd(itemsTotal(t.payload))} {t.payload.currency}</b></td></tr>
              </tbody>
            </table>
            {#if t.payload.description}<p class="note" style="margin:6px 0 0">{t.payload.description}</p>{/if}
          {:else if t.type.endsWith("payment-mandate:v1")}
            <p class="pm">“{t.payload.prompt_summary}”</p>
            <div class="kv">
              <span class="k">Up to</span><span><b>{usd(t.payload.amount)} {t.payload.currency}</b></span>
              <span class="k">Payee</span><span>{t.payload.payee?.name}</span>
              <span class="k">Instrument</span><span class="mono" style="font-size:11.5px">{t.payload.payment_instrument?.description ?? short(t.payload.payment_instrument?.id, 14, 8)}</span>
            </div>
          {:else if t.type.endsWith("session-data")}
            <div class="kv"><span class="k">IP address</span><span class="mono">{t.payload.ip_address}</span>{#if t.payload.device_id}<span class="k">Device</span><span class="mono">{t.payload.device_id}</span>{/if}</div>
          {:else}
            <pre class="mono raw">{JSON.stringify(t.payload, null, 2)}</pre>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if mandate}
    <div class="sec">
      <div class="sec-h">The agent may act alone, within</div>
      <ul class="cons">{#each mandate.constraints as c}<li>{constraintText(c)}</li>{/each}<li>for {Math.round(mandate.validitySeconds / 3600)} hours</li></ul>
      <div class="note">Signed with <b>your credential's key</b>, naming this agent's key
        <span class="mono">{short(mandate.agent.kid, 8, 6)}</span> and wallet <span class="mono">{short(mandate.agent.id.split(":").pop(), 6, 4)}</span>. No server signs on your behalf.</div>
    </div>
  {/if}

  {#if billing === "x402" && !mandate}
    <p class="note" style="margin:10px 0 0">This verifier pays Proof per presentation with <b>x402</b>, so yours leaves with its signatures detached — readable, but unverifiable until the verifier buys them back.</p>
  {/if}

  <div class="row" style="margin-top:14px;gap:8px">
    <button onclick={() => onapprove(shown)} disabled={busy || !allOk || missing.length > 0 || (choosable && picked.length === 0)}>{approveLabel}</button>
    {#if ondecline}<button class="ghost" onclick={ondecline} disabled={busy}>Decline</button>{/if}
    {#if !allOk}<span class="mut" style="font-size:12px;color:var(--bad)">The request failed a check — a wallet must not answer it.</span>{/if}
  </div>
</div>

<style>
  .sheet {
    border: 1px solid rgba(47, 210, 160, 0.4); border-radius: 14px; padding: 14px 14px 16px;
    background: linear-gradient(180deg, rgba(47, 210, 160, 0.06), var(--panel2));
  }
  .sheet-head { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; }
  .wallet-mark { font-size: 20px; color: var(--ok); }
  .wl { font-weight: 800; font-size: 13px; letter-spacing: 0.02em; }
  .checks { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; }
  .sec { margin-top: 12px; }
  .sec-h { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--mut); margin-bottom: 6px; }
  .term { border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; margin-bottom: 8px; background: var(--chip); }
  .term-h { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
  .term table td { padding: 4px 6px; border-bottom: 0; }
  .pm { margin: 2px 0 8px; font-style: italic; }
  .cons { margin: 0 0 8px; padding-left: 18px; font-size: 12.5px; }
  .raw { font-size: 11px; white-space: pre-wrap; margin: 0; }
</style>
