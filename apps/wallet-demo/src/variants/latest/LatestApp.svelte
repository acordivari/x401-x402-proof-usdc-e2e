<script lang="ts">
  /**
   * The latest variant: Proof's current x401 stack, end to end.
   *
   * Who does what, which is the main change from July: the MERCHANT is the
   * x401 verifier — it signs the request, verifies the presentation, enforces
   * the mandate. The server-side agent is only the user agent: it fetches,
   * hands the PROOF-REQUEST to your wallet, and retries. Your wallet is one of
   * three: the demo wallet in this page, Proof's Cloud Wallet through a
   * handoff link (emulated offline), or whatever the browser's Digital
   * Credentials API reaches.
   */
  import { onMount } from "svelte";
  import { api, atomicUsd, fmtClaim, leaves, short, usd, TEMPLATE_LABEL } from "./lib/api";
  import { clearHolder, holderKeys, loadCredential, saveCredential, type HeldCredentialV1 } from "./lib/holder";
  import FlowViz from "./lib/FlowViz.svelte";
  import WalletSheet from "./lib/WalletSheet.svelte";
  import Exchanges from "./lib/Exchanges.svelte";
  import ProofPanel from "./lib/ProofPanel.svelte";
  import WhatsNew from "./lib/WhatsNew.svelte";
  import {
    answerDcApiRequest,
    mintDelegation,
    previewDcApiRequest,
    type ClientIdMetadataDocument,
    type DcApiPreview,
    type Jwk,
  } from "@agentic-payments/credentials/browser";

  type Mode = "purchase" | "mandate";
  type WalletPath = "demo" | "handoff" | "dc-api";

  let me = $state<any>(undefined);
  let catalog = $state<any[]>([]);
  let orders = $state<any[]>([]);
  let exhibit = $state<any>(undefined);
  let log = $state<{ msg: string; cls: string }[]>([]);
  let busy = $state(false);

  let mode = $state<Mode>("purchase");
  let wallet = $state<WalletPath>("demo");
  let persona = $state("Andrew Smith");
  /** Live only: the Proof sandbox email Proof should ask (the request's login_hint). */
  let loginHint = $state("");
  let credential = $state<HeldCredentialV1 | undefined>(undefined);
  let sku = $state("vitamin-d3-2000");

  let purchase = $state<any>(undefined);
  let preview = $state<DcApiPreview | undefined>(undefined);
  let previewError = $state<string | undefined>(undefined);
  let metadata: ClientIdMetadataDocument | undefined;

  let budget = $state(5);
  let perPurchase = $state(3);
  let hours = $state(24);
  let cats = $state<string[]>([]);
  let mandateRequest = $state<any>(undefined);
  let delegation = $state<any>(undefined);
  let runs = $state<any[]>([]);
  let openRun = $state<string | undefined>(undefined);

  const WALLETS: WalletPath[] = ["demo", "handoff", "dc-api"];
  const dcApiAvailable = typeof window !== "undefined" && "DigitalCredential" in window && !!navigator.credentials;
  const live = $derived(me?.mode === "live");
  const walletLabel: Record<WalletPath, string> = {
    demo: "Demo wallet (this page)",
    handoff: "Proof Cloud Wallet",
    "dc-api": "Browser (DC API)",
  };
  const product = $derived(catalog.find((p) => p.sku === sku));
  const restricted = $derived(new Set<string>(me?.verifier?.ageRestrictedCategories ?? []));
  const lastRun = $derived(runs[runs.length - 1]);
  const logLine = (msg: string, cls = "info") => (log = [{ msg, cls }, ...log].slice(0, 60));

  const remember = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} };
  const recall = (k: string) => { try { return localStorage.getItem(k) ?? undefined; } catch { return undefined; } };

  async function init() {
    mode = (recall("x401v1.mode") as Mode) ?? "purchase";
    loginHint = recall("x401v1.loginHint") ?? "";
    await refresh();
    const saved = recall("x401v1.wallet") as WalletPath | undefined;
    wallet = saved && me?.walletPaths?.includes(saved) ? saved : me?.walletPaths?.[0] ?? "demo";
    if (mode === "mandate" && !me?.verifier?.delegatedAuthority) mode = "purchase";
    cats = [...(me?.categories ?? [])];
    catalog = ((await api("/api/catalog")).products ?? []) as any[];
    exhibit = await api("/api/proof/exhibit").catch(() => undefined);
    if (!live) credential = loadCredential(me?.issuer?.kid);
    refreshOrders();
  }

  onMount(() => {
    void init();
    const t1 = setInterval(refreshOrders, 3000);
    // A handoff completes on Proof's side and is POSTed back to the server; poll for it.
    const t2 = setInterval(() => {
      if (purchase?.status === "awaiting-wallet" || purchase?.status === "completing") void refresh();
    }, 1500);
    return () => { clearInterval(t1); clearInterval(t2); };
  });

  async function refresh() {
    me = await api("/api/latest/me");
    const s = me?.session ?? {};
    const before = purchase?.status;
    purchase = s.purchase;
    delegation = s.delegation;
    runs = s.runs ?? [];
    if (before === "awaiting-wallet" && purchase?.status && purchase.status !== "awaiting-wallet" && purchase.wallet === "handoff") {
      reportOutcome();
    }
  }
  async function refreshOrders() {
    const r = await api("/api/orders").catch(() => ({ orders: [] }));
    orders = (r.orders ?? []).sort((a: any, b: any) => b.updatedAt - a.updatedAt).slice(0, 8);
  }

  function setMode(m: Mode) { mode = m; remember("x401v1.mode", m); }
  function setWallet(w: WalletPath) { wallet = w; remember("x401v1.wallet", w); }

  async function provision() {
    busy = true;
    try {
      const keys = await holderKeys();
      const r = await api("/api/latest/wallet/issue", { holderPublicJwk: keys.publicJwk, persona });
      if (r.error) return logLine(`Issuance failed: ${r.error}`, "bad");
      credential = { ...r.credential, issuerKid: r.credential.issuerKid } as HeldCredentialV1;
      saveCredential(credential);
      logLine(`Credential issued to ${persona} — ProofCredentialV1-shaped, held in this browser`, "ok");
    } finally { busy = false; }
  }

  async function verifierMetadata(): Promise<ClientIdMetadataDocument> {
    metadata ??= (await (await fetch("/.well-known/proof-client.json")).json()) as ClientIdMetadataDocument;
    return metadata;
  }
  const requestOf = (p: any): string => p?.credentialRequirements?.digital?.requests?.[0]?.data?.request;

  async function startPurchase() {
    if (!product) return;
    busy = true; preview = undefined; previewError = undefined;
    try {
      logLine(`Agent → GET /x401/buy/${sku}`, "info");
      if (live) remember("x401v1.loginHint", loginHint.trim());
      const r = await api("/api/latest/purchase/start", { sku, wallet, ...(live && loginHint.trim() ? { loginHint: loginHint.trim() } : {}) });
      if (r.error) return logLine(r.error, "bad");
      purchase = r.purchase;
      logLine(`401 PROOF-REQUEST · signed by ${me.verifier.clientName} · ${purchase.request.transactionData.length} term(s) to sign`, "info");
      if (wallet === "demo") await openSheet();
      if (wallet === "handoff") {
        logLine("Handed off to the Proof Cloud Wallet — approve in the window that opened", "info");
        const w = window.open(purchase.requestUri, "proof-cloud-wallet", "width=480,height=780");
        if (!w) logLine("Popup blocked — use the link on the card", "bad");
      }
    } finally { busy = false; }
  }

  async function openSheet() {
    try {
      preview = await previewDcApiRequest({
        request: requestOf(purchase),
        metadata: await verifierMetadata(),
        origin: location.origin,
        audience: me.verifier.walletAudience,
      });
    } catch (err) {
      previewError = String((err as Error).message ?? err);
      logLine(`Wallet refused the request: ${previewError}`, "bad");
    }
  }

  async function approveDemo() {
    if (!credential || !purchase) return;
    busy = true;
    try {
      const keys = await holderKeys();
      const billing = me.verifier.signatureBilling;
      const ans = await answerDcApiRequest({
        request: requestOf(purchase),
        metadata: await verifierMetadata(),
        origin: location.origin,
        audience: me.verifier.walletAudience,
        credential: credential.compact,
        holderPrivateJwk: keys.privateJwk as Jwk,
        ...(billing === "x402"
          ? { detach: async (id: string, sigs: any) => { await api("/emulator/proof/wallet/signatures", { id, ...sigs }); } }
          : {}),
      });
      logLine(`Presented ${ans.preview.disclose.map((p) => p.join(".")).join(", ")} · signed ${ans.preview.terms.length} term(s)`, "ok");
      preview = undefined;
      await complete(ans.result);
    } catch (err) {
      logLine(`Wallet error: ${String(err)}`, "bad");
    } finally { busy = false; }
  }

  async function viaDcApi() {
    if (!purchase) return;
    busy = true;
    try {
      const cred: any = await (navigator.credentials as any).get({ digital: purchase.credentialRequirements.digital, mediation: "required" });
      if (!cred) return logLine("No credential returned", "bad");
      logLine(`Browser returned a ${cred.protocol} result`, "ok");
      await complete({ protocol: cred.protocol, data: cred.data });
    } catch (err) {
      logLine(`Digital Credentials API: ${String((err as Error).message ?? err)}`, "bad");
    } finally { busy = false; }
  }

  async function complete(credentialResult: unknown) {
    logLine("Agent → token exchange → retry with PROOF-RESPONSE → pay", "info");
    const r = await api("/api/latest/purchase/complete", { credentialResult });
    if (r.error) return logLine(r.error, "bad");
    purchase = r.purchase;
    reportOutcome();
    refreshOrders();
  }

  function reportOutcome() {
    const o = purchase?.outcome;
    if (!o) return;
    if (o.ok) {
      const paid = o.receipt?.authorization?.signaturePayments?.length;
      logLine(`✓ ${product?.name ?? purchase.sku} settled${o.settled?.payment?.txHash ? ` · tx ${short(o.settled.payment.txHash, 10, 6)}` : ""}${paid ? " · merchant paid Proof for the signatures via x402" : ""}`, "ok");
    } else {
      logLine(`✗ refused: ${o.refusal ?? o.error ?? `HTTP ${o.status}`}${o.proofResult ? ` (${o.proofResult.error})` : ""}`, "bad");
    }
  }

  async function requestMandate() {
    busy = true;
    try {
      const r = await api("/api/latest/mandate/request", { budgetUsd: budget, perPurchaseUsd: perPurchase, validityHours: hours, categories: cats });
      if (r.error) return logLine(r.error, "bad");
      mandateRequest = r.request;
      logLine(`Agent asks for a standing mandate: ${usd(budget)} total, ${usd(perPurchase)} per purchase`, "info");
    } finally { busy = false; }
  }

  async function approveMandate(chosen: string[]) {
    if (!credential || !mandateRequest) return;
    busy = true;
    try {
      const keys = await holderKeys();
      const minted = await mintDelegation({
        credential: credential.compact,
        holderPrivateJwk: keys.privateJwk as Jwk,
        disclose: chosen.map((p) => p.split(".")),
        request: mandateRequest,
      });
      const r = await api("/api/latest/mandate/accept", { delegation: minted.delegation });
      if (r.error) return logLine(r.error, "bad");
      delegation = r.delegation;
      mandateRequest = undefined;
      runs = [];
      logLine(`Mandate signed with your credential key · id ${short(minted.mandateId, 8, 4)} · the agent can now buy on its own`, "ok");
    } catch (err) {
      logLine(`Mandate not minted: ${String(err)}`, "bad");
    } finally { busy = false; }
  }

  async function runAgent() {
    busy = true;
    try {
      logLine("Agent buying on its own under the mandate — no one approves these", "info");
      const r = await api("/api/latest/agent/run", {});
      if (r.error) return logLine(r.error, "bad");
      runs = [...runs, r.run];
      delegation = r.delegation;
      for (const p of r.run.purchases) {
        logLine(p.ok ? `✓ ${p.name} ($${p.priceUsd}) settled` : `✗ ${p.name ?? p.sku} refused: ${p.refusal}`, p.ok ? "ok" : "bad");
      }
      refreshOrders();
    } finally { busy = false; }
  }

  async function revoke() {
    busy = true;
    try {
      const r = await api("/api/latest/mandate/revoke", {});
      if (r.revoked) { logLine("Mandate revoked — the merchant now refuses it, signature or not", "ok"); await refresh(); }
      else logLine(r.error ?? "revoke failed", "bad");
    } finally { busy = false; }
  }

  async function reset() {
    busy = true;
    try {
      await api("/api/latest/reset", {});
      clearHolder();
      credential = undefined; purchase = undefined; preview = undefined; previewError = undefined;
      mandateRequest = undefined; delegation = undefined; runs = []; log = [];
      logLine("Reset — session cleared and the browser wallet emptied", "info");
      await refresh();
    } finally { busy = false; }
  }

  const statusOf = (p: any, step: string): "todo" | "active" | "done" | "bad" => {
    const ex: any[] = p?.exchanges ?? [];
    const has = (f: (e: any) => boolean) => ex.some(f);
    const refused = p?.status === "refused" || p?.status === "error";
    switch (step) {
      case "401": return has((e) => e.status === 401) ? "done" : p ? "active" : "todo";
      case "wallet": return has((e) => e.path?.endsWith("/x401/token")) ? "done" : p?.status === "awaiting-wallet" ? "active" : refused ? "bad" : "todo";
      case "token": return has((e) => e.path?.endsWith("/x401/token") && e.status === 200) ? "done" : has((e) => e.path?.endsWith("/x401/token")) ? "bad" : "todo";
      case "402": return has((e) => e.status === 402) ? "done" : refused && has((e) => e.path?.endsWith("/x401/token") && e.status === 200) ? "bad" : "todo";
      case "200": return p?.status === "settled" ? "done" : refused && has((e) => e.status === 402) ? "bad" : "todo";
      default: return "todo";
    }
  };

  const steps = $derived.by(() => {
    const held = live || !!credential;
    const s = (status: any, title: string, sub: string) => ({ status, title, sub });
    if (mode === "mandate") {
      const run = lastRun?.purchases ?? [];
      return [
        s(held ? "done" : "active", "Hold a credential", live ? "in Proof's Cloud Wallet" : "ProofCredentialV1-shaped, in this browser"),
        s(delegation || mandateRequest ? "done" : held ? "active" : "todo", "Agent asks for a mandate", "payment_mandate_v1 terms + its key"),
        s(delegation ? "done" : mandateRequest ? "active" : "todo", "You sign it", "with your credential's key (L2)"),
        s(run.length ? "done" : delegation ? "active" : "todo", "Merchant: 401 per purchase", "fresh nonce, signed request"),
        s(run.some((p: any) => p.ok) ? "done" : run.length ? "bad" : "todo", "Agent proves alone", "L3 over the nonce → token"),
        s(run.some((p: any) => p.settled) ? "done" : "todo", "402 → pay", "budget enforced at the merchant"),
        s(delegation?.revoked ? "done" : "todo", "Revoke anytime", "the merchant refuses it after"),
      ];
    }
    return [
      s(held ? "done" : "active", "Hold a credential", live ? "in Proof's Cloud Wallet" : "ProofCredentialV1-shaped, in this browser"),
      s(statusOf(purchase, "401"), "GET → 401", "PROOF-REQUEST, signed DC API request"),
      s(statusOf(purchase, "wallet"), "Wallet consent", walletLabel[(purchase?.wallet ?? wallet) as WalletPath]),
      s(statusOf(purchase, "token"), "Token exchange", "Result Artifact → Verification Token"),
      s(statusOf(purchase, "402"), "Retry → 402", "proof satisfied, payment not"),
      s(statusOf(purchase, "200"), "Pay over x402 → 200", "payer must be the bound agent"),
      s(purchase?.outcome?.settled?.state === "SETTLED" ? "done" : "todo", "Settled", "facilitator submits the transfer"),
    ];
  });

  const exhibitOk = $derived(exhibit?.available && exhibit?.liveVerification?.asRecorded?.ok);
  const cn = (dn?: string) => dn?.split("\n").find((p: string) => p.startsWith("CN="))?.slice(3);
</script>

<header class="top">
  <div>
    <h1>Who is this? Says who? Did they authorize <i>this</i>?</h1>
    <p>The merchant asks for proof and for payment separately. Your wallet answers the first, and the agent pays the second.</p>
  </div>
  <div class="row">
    <span class="pill" title="x401 0.2.0 · @proof.com/x401-node 0.3.3 · proof-vc 0.6.3">x401 0.2 · proof-vc 0.6</span>
    <span class="pill">{#if live}<b style="color:var(--ok)">live Proof</b>{:else}offline <span class="mut">· emulated Proof</span>{/if}</span>
    {#if me?.agent}<span class="pill" title={me.agent.id}>agent <span class="mono">{short(me.agent.wallet)}</span></span>{/if}
    <button class="ghost" onclick={reset} disabled={busy}>Reset</button>
  </div>
</header>

<div class="wrap">
  <WhatsNew />

  <div class="flowbar">
    <span class="mut" style="font-size:12px">Mode</span>
    <div class="seg">
      <button class="seg-btn {mode === 'purchase' ? 'on' : ''}" onclick={() => setMode("purchase")} disabled={busy}>Approve each purchase</button>
      <button class="seg-btn {mode === 'mandate' ? 'on' : ''}" onclick={() => setMode("mandate")} disabled={busy || !me?.verifier?.delegatedAuthority} title={me?.verifier?.delegatedAuthority ? "" : "Delegate Authority is early access at Proof — offline mode only"}>Standing mandate</button>
    </div>
    {#if mode === "purchase"}
      <span class="mut" style="font-size:12px">Wallet</span>
      <div class="seg">
        {#each WALLETS as w}
          <button
            class="seg-btn {wallet === w ? 'on' : ''}"
            disabled={busy || !me?.walletPaths?.includes(w) || (w === "dc-api" && !dcApiAvailable)}
            title={w === "dc-api" && !dcApiAvailable ? "This browser has no Digital Credentials API" : w === "demo" && live ? "Live mode verifies Proof credentials only" : ""}
            onclick={() => setWallet(w)}
          >{walletLabel[w]}{#if w === "handoff" && !live}<span class="tag">emulated</span>{/if}</button>
        {/each}
      </div>
    {/if}
  </div>

  <div class="grid">
    <div class="col">
      <div class="card">
        <h2><span class="step">1</span> Credential</h2>
        {#if live}
          <p class="note" style="margin:0 0 10px">Your credential lives in <b>Proof's Cloud Wallet</b>. You'll approve on Proof's own screen, and the merchant verifies it against Proof's root CA.</p>
          <label class="row" style="gap:8px">
            <span class="mut">Proof sandbox email</span>
            <input type="email" bind:value={loginHint} placeholder={me?.verifier?.loginHintConfigured ? "(the operator's default)" : "you@example.com"} autocomplete="email" style="flex:1;min-width:180px;background:var(--chip);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:7px 9px" />
          </label>
          <p class="note" style="margin:6px 0 0">Sent as the request's <span class="mono">login_hint</span>, so Proof knows whom to ask.</p>
        {:else}
          <div class="row spread">
            <div class="row"><span class="mut">Persona</span>
              <select bind:value={persona} disabled={busy}>{#each me?.personas ?? [] as p}<option value={p}>{p}</option>{/each}</select>
            </div>
            <button onclick={provision} disabled={busy}>{credential ? "Re-issue" : "Issue credential"}</button>
          </div>
          {#if credential}
            <div class="divider"></div>
            <div class="row" style="gap:6px">
              {#each leaves(credential.claims) as [k, v]}<span class="chip-claim">{k}: <b style="margin-left:4px">{fmtClaim(v)}</b></span>{/each}
            </div>
            <p class="note" style="margin:10px 0 0">An SD-JWT VC in the shape of Proof's <span class="mono">ProofCredentialV1</span>, issued by the demo's own issuer under a sandbox <span class="mono">vct</span>. Every claim, including each age threshold, can be disclosed on its own.</p>
          {/if}
        {/if}
      </div>

      {#if mode === "purchase"}
        <div class="card">
          <h2><span class="step">2</span> What the agent buys</h2>
          {#each catalog as p}
            <div class="prod {p.sku === sku ? 'sel' : ''}">
              <label class="row" style="gap:8px;cursor:pointer">
                <input type="radio" name="sku-latest" value={p.sku} bind:group={sku} disabled={busy} />
                <span><b>{p.name}</b><br /><span class="mut" style="font-size:12px">{p.category}{#if restricted.has(p.category)} · <span style="color:var(--warn)">18+</span>{/if}</span></span>
              </label>
              <span class="pill">${p.priceUsd}</span>
            </div>
          {/each}
          <div class="row spread" style="margin-top:12px">
            <span class="note">The agent requests it, and the merchant's 401 tells it what proof it needs.</span>
            <button onclick={startPurchase} disabled={busy || (!live && !credential && wallet !== "dc-api") || (live && wallet === "handoff" && !loginHint.trim() && !me?.verifier?.loginHintConfigured)}>Agent: GET /x401/buy/{sku}</button>
          </div>
        </div>

        {#if purchase}
          <div class="card fade-in" style="border-color:rgba(138,107,255,.45)">
            <h2><span class="step" style="background:var(--acc2)">401</span> PROOF-REQUEST from {me?.verifier?.clientName}</h2>
            <div class="kv">
              <span class="k">client_id</span><a class="mono" href={purchase.request?.claims?.client_id} target="_blank" rel="noreferrer">{purchase.request?.claims?.client_id}</a>
              <span class="k">scope</span><span class="mono">{purchase.request?.claims?.scope?.split(":").slice(-1)[0]} → {(me?.scopes ?? []).find((s: any) => s.scope === purchase.request?.claims?.scope)?.disclosures?.join(", ")}</span>
              <span class="k">expected_origins</span><span class="mono">{(purchase.request?.claims?.expected_origins ?? []).join(", ")}</span>
              <span class="k">nonce</span><span class="mono">{purchase.request?.claims?.nonce}</span>
              <span class="k">terms</span><span>{#each purchase.request?.transactionData ?? [] as t}<span class="badge b-mut" style="margin-right:4px">{TEMPLATE_LABEL[t.type] ?? t.type}</span>{/each}</span>
            </div>
            {#if purchase.status === "awaiting-wallet"}
              <div class="divider"></div>
              {#if purchase.wallet === "demo"}
                {#if preview}
                  <WalletSheet
                    walletLabel="Demo wallet · this page"
                    verifierName={preview.clientName}
                    clientId={preview.claims.client_id}
                    checks={[
                      { label: "signed by a key in the verifier's metadata", ok: true },
                      { label: `origin ${location.origin} listed`, ok: true },
                      { label: "addressed to this wallet", ok: true },
                      { label: `expires in ${Math.max(0, preview.claims.exp - Math.floor(Date.now() / 1000))}s`, ok: true },
                    ]}
                    held={credential?.claims}
                    disclose={preview.disclose.map((p) => p.join("."))}
                    terms={preview.terms}
                    billing={me?.verifier?.signatureBilling}
                    {busy}
                    onapprove={approveDemo}
                    ondecline={() => { preview = undefined; logLine("Declined in the wallet — nothing was shared", "info"); }}
                  />
                {:else if previewError}
                  <p class="note" style="color:var(--bad)">The wallet refused this request: {previewError}</p>
                {:else}
                  <button onclick={openSheet} disabled={busy}>Open the wallet</button>
                {/if}
              {:else if purchase.wallet === "handoff"}
                <p class="note">Handed off to the <b>Proof Cloud Wallet</b>{live ? "" : " (emulated)"} with a return channel. Approve there, and the wallet posts the presentation back to this demo.</p>
                <div class="row" style="gap:8px">
                  <a class="btnlink" href={purchase.requestUri} target="proof-cloud-wallet" rel="noreferrer">Open the wallet ↗</a>
                  <span class="mut" style="font-size:12px">waiting for the wallet…</span>
                </div>
              {:else}
                <p class="note">This hands the merchant's request, unchanged, to <span class="mono">navigator.credentials.get()</span>. Whichever wallet the browser offers answers it, and none is chosen up front.</p>
                <button onclick={viaDcApi} disabled={busy || !dcApiAvailable}>Ask the browser</button>
              {/if}
            {:else if purchase.outcome}
              <div class="divider"></div>
              {#if purchase.outcome.ok}
                <p style="margin:0"><span class="badge b-ok">settled</span> <b>{product?.name ?? purchase.sku}</b> · {purchase.outcome.receipt?.amountUsd ? `$${purchase.outcome.receipt.amountUsd}` : ""} USDC</p>
              {:else}
                <p style="margin:0"><span class="badge b-bad">refused</span> {purchase.outcome.refusal ?? purchase.outcome.error}</p>
              {/if}
            {/if}
          </div>
        {/if}
      {:else}
        <div class="card">
          <h2><span class="step">2</span> Grant a standing mandate</h2>
          <p class="note" style="margin:0 0 10px">Approve once, and the agent then buys with nobody in the loop. You sign the mandate with your <b>credential's own key</b>, and it names the agent's key. Every merchant checks it the same way, and no server stands in the middle.</p>
          <div class="row" style="gap:14px">
            <label class="row"><span class="mut">Total</span><input type="number" step="0.25" min="0.25" bind:value={budget} style="width:84px" /></label>
            <label class="row"><span class="mut">Per purchase</span><input type="number" step="0.25" min="0.25" bind:value={perPurchase} style="width:84px" /></label>
            <label class="row"><span class="mut">Hours</span><input type="number" min="1" max="720" bind:value={hours} style="width:70px" /></label>
          </div>
          <div class="mut" style="margin:10px 0 6px;font-size:12px">Categories the agent may buy from:</div>
          <div class="row" style="gap:6px">
            {#each me?.categories ?? [] as c}
              <button type="button" class="chip-claim {cats.includes(c) ? 'on' : ''}" onclick={() => (cats = cats.includes(c) ? cats.filter((x) => x !== c) : [...cats, c])}>{c}{#if restricted.has(c)} · 18+{/if}</button>
            {/each}
          </div>
          <div class="row spread" style="margin-top:12px">
            <span class="note">The agent asks, and your wallet shows the request.</span>
            <button onclick={requestMandate} disabled={busy || !credential || !!delegation}>{delegation ? "Mandate active" : "Agent: request a mandate"}</button>
          </div>
          {#if mandateRequest}
            <div class="divider"></div>
            <WalletSheet
              walletLabel="Demo wallet · this page"
              verifierName="Your agent"
              clientId={mandateRequest.agent.id}
              held={credential?.claims}
              disclose={["given_name", "family_name", "age_equal_or_over.18"]}
              choosable={true}
              terms={[{ type: "urn:proof:params:vc:transaction-data:payment-mandate:v1", payload: mandateRequest.terms }]}
              mandate={mandateRequest}
              {busy}
              approveLabel="Sign the mandate"
              onapprove={approveMandate}
              ondecline={() => { mandateRequest = undefined; logLine("Mandate declined", "info"); }}
            />
          {/if}
        </div>

        {#if delegation}
          <div class="card fade-in">
            <h2><span class="step">3</span> The agent, on its own</h2>
            <div class="row" style="gap:6px;margin-bottom:10px">
              <span class="pill">total {usd(delegation.terms.amount)}</span>
              <span class="pill">per purchase {usd(delegation.constraints.find((c: any) => c.type === "mandate.payment.amount_range")?.max)}</span>
              <span class="pill">until {new Date(delegation.expiresAt * 1000).toLocaleString()}</span>
              {#if delegation.revoked}<span class="pill" style="color:var(--bad);border-color:var(--bad)">revoked</span>{/if}
            </div>
            <p class="note" style="margin:0 0 10px">“{delegation.terms.prompt_summary}”</p>
            <div class="row" style="gap:8px">
              <button class="alt" onclick={runAgent} disabled={busy}>Run the agent</button>
              <button class="ghost" onclick={revoke} disabled={busy || delegation.revoked}>{delegation.revoked ? "Revoked" : "Revoke mandate"}</button>
            </div>
            {#if lastRun}
              <div class="divider"></div>
              {#each lastRun.purchases as p}
                <div class="prod" style="flex-wrap:wrap">
                  <span><b>{p.name ?? p.sku}</b><br /><span class="mut" style="font-size:12px">{p.category ?? ""}{p.ok ? "" : ` · ${p.refusal ?? ""}`}</span></span>
                  <span class="row" style="gap:6px">
                    <span class="pill" style={p.ok ? "color:var(--ok)" : "color:var(--warn)"}>{p.ok ? `settled $${p.priceUsd}` : "refused"}</span>
                    <button class="ghost" style="padding:3px 9px;font-size:11px" onclick={() => (openRun = openRun === p.sku ? undefined : p.sku)}>HTTP</button>
                  </span>
                </div>
                {#if openRun === p.sku}<Exchanges exchanges={p.exchanges ?? []} />{/if}
              {/each}
            {/if}
          </div>
        {/if}
      {/if}

      <div class="card">
        <h2>Activity</h2>
        <div class="log">
          {#each log as l}<div class={l.cls}>{l.msg}</div>{/each}
          {#if !log.length}<div class="mut">No activity yet.</div>{/if}
        </div>
      </div>

      <div class="card">
        <h2>Merchant orders <span class="mut" style="text-transform:none;letter-spacing:0;margin-left:auto;font-size:11px">shared by every visitor</span></h2>
        {#if orders.length}
          <table>
            <thead><tr><th>Order</th><th>Item</th><th>Amount</th><th>State</th></tr></thead>
            <tbody>
              {#each orders as o}
                <tr><td class="mono">{short(o.id, 8, 4)}</td><td>{o.sku}</td><td>{atomicUsd(o.amount)}</td><td><span class="badge {o.state === 'SETTLED' ? 'b-ok' : o.state === 'FAILED' ? 'b-bad' : 'b-warn'}">{o.state}</span></td></tr>
              {/each}
            </tbody>
          </table>
        {:else}<p class="mut" style="margin:0">No orders yet.</p>{/if}
      </div>
    </div>

    <div class="col">
      {#if mode === "purchase"}<ProofPanel outcome={purchase?.outcome} verifier={me?.verifier} />{/if}

      <div class="card">
        <h2>HTTP, as it happened</h2>
        {#if mode === "purchase"}
          <Exchanges exchanges={purchase?.exchanges ?? []} />
        {:else if lastRun}
          <p class="note" style="margin:0">Each purchase above makes its own four requests (401, token, 402, 200). Open one with its <b>HTTP</b> button.</p>
        {:else}
          <p class="mut" style="margin:0;font-size:12.5px">The agent hasn't run yet.</p>
        {/if}
      </div>

      <div class="card">
        <h2>The verifier's identity {#if !live}<span class="badge b-mut" style="margin-left:auto">emulated Proof</span>{/if}</h2>
        {#if me?.verifier}
          <div class="kv">
            <span class="k">client_id</span><a class="mono" href={me.verifier.clientId} target="_blank" rel="noreferrer">{me.verifier.clientId}</a>
            <span class="k">Shown to people as</span><span>{me.verifier.clientName}</span>
            <span class="k">Signing key</span><span class="mono">ES256 · kid {short(me.verifier.cimd?.jwks?.keys?.[0]?.kid, 10, 6)}</span>
            <span class="k">May be invoked from</span><span class="mono">{(me.verifier.cimd?.redirect_uris ?? []).join(", ")}</span>
            <span class="k">Requests addressed to</span><span class="mono">{me.verifier.walletAudience}</span>
            <span class="k">Pays Proof by</span><span>{me.verifier.signatureBilling === "x402" ? `x402, per presentation${me.verifier.signaturePrice ? ` ($${me.verifier.signaturePrice.usd}, emulated)` : ""}` : "card or bank account on file"}</span>
          </div>
          <p class="note" style="margin:10px 0 0">There's no OAuth app or client secret. The <span class="mono">client_id</span> is the URL of this metadata document, and a verifier enrolls by registering that URL with Proof.</p>
        {/if}
      </div>

      {#if exhibit?.available}
        <div class="card" style="border-color:rgba(47,210,160,.45)">
          <h2><span class="step" style="background:var(--ok)">real</span> A genuine Proof credential, re-checked</h2>
          <div class="kv">
            <span class="k">Verified now</span><span>{#if exhibitOk}<span class="badge b-ok">✓ proof-vc-server 0.6.3</span>{:else}<span class="badge b-bad">✗</span>{/if}</span>
            <span class="k">Issued by</span><span class="mono" style="font-size:11.5px">{cn(exhibit.credential?.issuerCert?.issuer) ?? exhibit.credential?.issuer}</span>
            <span class="k">Type</span><span class="mono" style="font-size:11.5px">{exhibit.credential?.vct}</span>
            <span class="k">Disclosed</span><span>{#each exhibit.disclosure?.disclosed ?? [] as d}<span class="chip-claim claim-disclosed" style="margin:2px">{d.name}</span>{/each}</span>
            <span class="k">As a new request</span><span>{#if exhibit.liveVerification?.asReplayed?.ok === false}<span class="badge b-ok">refused ✓</span> <span class="mut">nonce-bound</span>{:else}—{/if}</span>
          </div>
          <p class="note" style="margin:10px 0 0">Recorded in August against Proof's sandbox and verified offline against the trust store that ships in the SDK. It's already the credential type the latest flow expects. Switch to the <b>July 2026</b> variant for the full walkthrough.</p>
        </div>
      {/if}
    </div>
  </div>

  <div class="card fullrow">
    <h2>Protocol flow · {mode === "purchase" ? "one purchase" : "standing mandate"}</h2>
    <FlowViz {steps} layout="horizontal" />
  </div>
</div>

<style>
  .tag {
    font-size: 9.5px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase;
    padding: 1px 5px; border-radius: 5px; margin-left: 5px; vertical-align: 1px;
    background: rgba(147, 163, 196, 0.18); color: var(--mut);
  }
  .btnlink {
    display: inline-block; background: linear-gradient(180deg, var(--ok), #23b489); color: #05201a;
    border-radius: 9px; padding: 9px 14px; font-weight: 800; text-decoration: none;
  }
  .kv a { word-break: break-all; }
  .kv span { min-width: 0; overflow-wrap: anywhere; }
</style>
