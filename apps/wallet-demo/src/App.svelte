<script lang="ts">
  import { onMount } from "svelte";
  import { api, usd, short } from "./lib/api";
  import FlowViz from "./lib/FlowViz.svelte";
  import PaymentAuthCard from "./lib/PaymentAuthCard.svelte";
  import MerchantPanel from "./lib/MerchantPanel.svelte";
  import MerchantOrders from "./lib/MerchantOrders.svelte";
  import ProofExhibit from "./lib/ProofExhibit.svelte";
  import ProofWalkthrough from "./lib/ProofWalkthrough.svelte";
  import StartHere from "./lib/StartHere.svelte";
  import ThreeQuestions from "./lib/ThreeQuestions.svelte";
  import {
    ensureHolderKeys,
    presentInBrowser,
    decodeDisclosed,
    saveCredential,
    loadCredential,
    clearWallet,
    type HeldCredential,
    type HolderKeys,
  } from "./lib/walletClient";
  import { DEMO_HOLDERS } from "@agentic-payments/credentials/browser";
  import "@proof.com/proof-vc-web"; // registers Proof's <proof-verify-id> web component

  let me = $state<any>({ mode: "local", claimUniverse: [] });
  let catalog = $state<any[]>([]);
  let orders = $state<any[]>([]);
  let log = $state<{ msg: string; cls: string }[]>([]);

  let keys = $state<HolderKeys | undefined>(undefined);
  let credential = $state<HeldCredential | undefined>(undefined);
  let persona = $state("andrew@example.com");

  let selectedSku = $state<string>("");
  let requested = $state<string[]>(["given_name", "family_name", "email", "age_over_21"]);
  let ttl = $state(600);

  let authSession = $state<any>(undefined);
  let present = $state<any>(undefined); // {disclosed, withheld, missing, vpToken}
  let verification = $state<any>(undefined);
  let intent = $state<any>(undefined);
  let busy = $state(false);
  let pasted = $state("");

  // Workflow axis: identity == "proof" means the Proof hosted SDK path (vs the
  // local self-issued browser wallet); delegated == the autonomous mandate flow.
  const proofIdentity = $derived(me.identity === "proof");
  const delegated = $derived(me.flow === "delegated");
  /**
   * The Proof tab on a deployment with no live Proof credentials. Deliberately
   * CLIENT-SIDE ONLY: it never POSTs /api/flow, so that endpoint keeps its
   * fail-closed 400 and the server's posture is untouched. It exists because a
   * greyed-out third option reads as "broken", when in fact the most valuable
   * artifact in the demo — a genuine Proof credential — is sitting right there.
   */
  let proofPreview = $state(false);
  // Auth gate (F1): when the orchestrator requires a token and we haven't passed
  // it, show only the login card. Off in local dev (authRequired is falsy).
  const needsLogin = $derived(me.authRequired === true && me.authed !== true);
  const revoked = $derived(me.revoked === true);
  let token = $state("");
  let budgetUsd = $state("5.00");
  let agentRun = $state<any>(undefined);
  // Whether THIS session settled a purchase. Deliberately not derived from the
  // orders list: /api/orders is the merchant's global ledger, shared by every
  // visitor, so another person's purchase would light up your protocol flow —
  // and Reset could never turn it off, since the poll refills it every 2s.
  let didSettle = $state(false);
  // The recorded real-Proof exhibit. Absent on a deployment with no recording,
  // in which case the card simply does not render.
  let exhibit = $state<any>(undefined);
  const proofPreviewable = $derived(me.proofLiveReady !== true && exhibit?.available === true);

  // Proof's official web component (@proof.com/proof-vc-web). We feed it our
  // server-built (PAR) authorize URL via `resolveAuthorizationUrl` so the client
  // secret stays server-side and the payment-mandate URL avoids size limits.
  let proofBtn = $state<any>(undefined);
  $effect(() => {
    if (proofBtn) proofBtn.resolveAuthorizationUrl = async () => authSession?.authorizeUrl ?? null;
  });

  // Display names only — the flow ids on the wire are unchanged. "Self-issued"
  // and "Proof-hosted" describe who issued the credential, which is not the
  // question a first-time visitor is asking; "whose wallet am I using" is.
  const FLOW_LABEL: Record<string, string> = {
    "self-issued": "Browser wallet",
    "proof-hosted": "Proof wallet",
    "delegated": "Standing mandate",
  };

  // Live mode: when the redirect_uri is a page we don't control, the user pastes
  // the returned URL (or raw vp_token) here to bring the presentation back.
  function extractVpToken(input: string): string | undefined {
    const s = input.trim();
    if (!s) return undefined;
    if (s.includes("#") || s.includes("vp_token=")) {
      const frag = s.includes("#") ? s.slice(s.indexOf("#") + 1) : s;
      return new URLSearchParams(frag).get("vp_token") ?? undefined;
    }
    return s; // assume a raw token was pasted
  }
  async function submitPasted() {
    const vpToken = extractVpToken(pasted);
    if (!vpToken) return logLine("Couldn't find a vp_token in that input.", "bad");
    pasted = "";
    await onVpToken(vpToken);
  }

  const logLine = (msg: string, cls = "info") => (log = [{ msg, cls }, ...log].slice(0, 60));
  const selectedProduct = $derived(catalog.find((p) => p.sku === selectedSku));
  const heldNames = $derived(credential?.claimNames ?? []);
  const previewDisclose = $derived(requested.filter((c) => heldNames.includes(c)));
  const previewWithheld = $derived(heldNames.filter((c) => !requested.includes(c)));
  const previewMissing = $derived(requested.filter((c) => !heldNames.includes(c)));

  // What the right-hand flow rail shows while the recorded Proof credential is
  // on screen. Same component, same vocabulary — the difference is that step 5
  // is a deliberate dead end rather than something the visitor can advance.
  const proofSteps = $derived([
    { status: "done" as const, title: "Proof issued the credential", sub: "SD-JWT-VC signed under an x5c chain" },
    { status: "done" as const, title: "Human approved a payment", sub: "sealed into the key-binding JWT" },
    {
      status: "done" as const,
      title: "Selective disclosure",
      sub: `${exhibit?.disclosure?.disclosedCount ?? 0} of ${exhibit?.disclosure?.totalSdClaims ?? 0} attributes revealed`,
    },
    { status: "done" as const, title: "Verified against the CA", sub: "offline — no call to Proof" },
    { status: "bad" as const, title: "Issue HAM Intent", sub: "refused — a recording is nonce-bound" },
  ]);

  const steps = $derived.by(() => {
    const provisioned = proofIdentity || !!credential;
    const settled = didSettle;
    const paying = !!intent && !settled;
    const s = (status: any, title: string, sub?: string) => ({ status, title, sub });
    return [
      s(provisioned ? "done" : "active", "Provision wallet", proofIdentity ? "Proof-hosted credential" : credential ? "credential held in browser" : "issue a credential"),
      s(authSession ? "done" : provisioned ? "active" : "todo", delegated ? "Request mandate grant" : "Request authorization", "PROOF-REQUIRED + payment transaction_data"),
      s(present ? "done" : authSession ? "active" : "todo", "Present credential", "selective disclosure (DCQL)"),
      s(verification ? (verification.ok ? "done" : "bad") : present ? "active" : "todo", "Verify presentation", "challenge + VC + payment binding"),
      s(intent ? "done" : verification?.ok ? "active" : "todo", delegated ? "Sign standing mandate" : "Issue HAM Intent", "bind verified identity → agent scope"),
      s(settled ? "done" : paying ? "active" : "todo", delegated ? "Agent buys autonomously" : "Pay via x402", delegated ? "no per-purchase human approval" : "EIP-3009 USDC authorization"),
      s(settled ? "done" : "todo", "Settle on-chain", "facilitator submits the transfer"),
    ];
  });

  onMount(async () => {
    await refreshMe();
    await tryLinkUnlock();
    // Pasting the link while ALREADY on the gate only changes the fragment — a
    // same-document navigation, so onMount never runs again. Listen for it, or
    // the link silently does nothing for anyone who already has the page open.
    window.addEventListener("hashchange", () => void tryLinkUnlock());
    const cat = await api("/api/catalog");
    catalog = cat.products ?? [];
    await loadExhibit();
    selectedSku = catalog[0]?.sku ?? "";
    if (me.identity !== "proof") {
      keys = await ensureHolderKeys();
      credential = loadWalletForCurrentIssuer();
    }
    // Fallback: if Proof redirected the whole tab to the origin with the token in
    // the fragment, complete it here (the /proof/callback page handles the normal case).
    const hp = new URLSearchParams(location.hash.slice(1));
    if (hp.get("vp_token")) { history.replaceState(null, "", "/"); await onVpToken(hp.get("vp_token")!); }
    const cb = localStorage.getItem("x401:callback");
    if (cb) { localStorage.removeItem("x401:callback"); const { vpToken } = JSON.parse(cb); if (vpToken) await onVpToken(vpToken); }
    // The callback page completes the authorization itself, then signals us.
    window.addEventListener("message", (e) => {
      if (e.origin !== location.origin) return;
      if (e.data?.type === "x401:done") { logLine("Proof presentation returned — refreshing…", "ok"); refreshMe(); refreshOrders(); }
      else if (e.data?.type === "x401:vp_token" && e.data.vpToken) onVpToken(e.data.vpToken);
    });
    refreshOrders();
    setInterval(refreshOrders, 2000);
    setInterval(refreshMe, 2500); // reflect verification/intent landed via the callback page
  });

  /**
   * Read the browser wallet back, discarding a credential minted by a previous
   * server boot. Without this the demo dead-ends: the presentation is rejected
   * ("untrusted issuer") and nothing on screen explains why or how to recover.
   */
  function loadWalletForCurrentIssuer(): HeldCredential | undefined {
    const held = loadCredential();
    if (!held) return undefined;
    if (me.issuerKid && held.issuerKid !== me.issuerKid) {
      clearWallet();
      logLine("Cleared a credential issued by a previous server instance — provision a new one.", "info");
      return undefined;
    }
    return held;
  }

  /**
   * Load the recorded Proof exhibit. A FUNCTION, not a one-off call in onMount,
   * because /api/proof/exhibit sits behind the access gate: on a token-gated
   * deployment the mount-time fetch 401s, `available` comes back undefined, and
   * the Proof tab then renders as a disabled control — the demo silently loses
   * its most valuable artifact for anyone who typed the token instead of
   * arriving via the `#token=` link (which authenticates before this runs).
   * So login() calls it again.
   */
  async function loadExhibit() {
    const r = await api("/api/proof/exhibit");
    exhibit = r?.available === true ? r : undefined;
  }

  /**
   * `gen` invalidates in-flight /api/me responses. Reset clears session state
   * locally and then re-reads, but a poll (every 2.5s) issued BEFORE the reset
   * can land after it, carrying the pre-reset intent/verification and putting
   * the Pay card and a lit-up protocol flow straight back on screen. From the
   * outside that is simply "Reset doesn't work", intermittently.
   */
  let meGen = 0;
  async function refreshMe() {
    const gen = meGen;
    const next = await api("/api/me");
    if (gen !== meGen) return; // superseded by a reset while this was in flight
    me = next;
    intent = me.intent ?? intent;
    if (me.verification) verification = me.verification;
    if (me.sku) selectedSku = me.sku; // restore the in-flight purchase after a redirect
  }
  async function refreshOrders() {
    const r = await api("/api/orders");
    orders = (r.orders ?? []).sort((a: any, b: any) => b.updatedAt - a.updatedAt);
  }

  function toggleClaim(c: string) {
    requested = requested.includes(c) ? requested.filter((x) => x !== c) : [...requested, c];
  }

  // Clipboard needs a secure context (https, or localhost in dev). When it is
  // unavailable the token is still on screen as selectable text, so the gate
  // degrades to plain copy/paste rather than breaking.
  let copied = $state("");
  const unlockLink = $derived(
    me.publicToken ? `${location.origin}${location.pathname}#token=${encodeURIComponent(me.publicToken)}` : "",
  );
  async function copyUnlock(what: "token" | "link") {
    try {
      await navigator.clipboard.writeText(what === "link" ? unlockLink : me.publicToken);
      copied = what;
      setTimeout(() => (copied = ""), 1500);
    } catch {
      logLine("Clipboard unavailable — select the token above and copy it manually.", "bad");
    }
  }

  /**
   * Shareable unlock link: `#token=…` submits the published demo token so a URL
   * can be handed out without asking anyone to retype it. A FRAGMENT, not a query
   * param, on purpose — it never reaches the server, a proxy log, or a Referer
   * header. It is stripped once spent so it can't linger in the address bar
   * through a screen share.
   */
  async function tryLinkUnlock() {
    const linkToken = new URLSearchParams(location.hash.slice(1)).get("token");
    if (!linkToken || !needsLogin) return;
    token = linkToken;
    history.replaceState(null, "", location.pathname);
    await login();
  }

  async function login() {
    // Trim before sending: the server compares byte-exact, and a token people are
    // meant to COPY arrives with a trailing newline or space often enough that
    // "Invalid access token" would usually be a paste artifact, not a wrong token.
    const r = await api("/api/login", { token: token.trim() });
    if (r?.authed) {
      token = "";
      await refreshMe();
      const cat = await api("/api/catalog");
      catalog = cat.products ?? catalog;
      if (!selectedSku) selectedSku = catalog[0]?.sku ?? "";
      if (me.identity !== "proof") { keys = await ensureHolderKeys(); credential = loadWalletForCurrentIssuer(); }
      await loadExhibit(); // gated: the mount-time fetch 401'd, so get it now
      refreshOrders();
      logLine("Unlocked.", "ok");
    } else if (r?.retryAfter) {
      // Throttled, not wrong: the gate caps attempts per IP, so a CORRECT token
      // is refused too until the window closes. Say so, or this reads as "invalid".
      logLine(`Too many attempts — wait ${r.retryAfter}s before trying again.`, "bad");
    } else {
      logLine("Invalid access token.", "bad");
    }
  }

  async function provision() {
    busy = true;
    try {
      keys = await ensureHolderKeys();
      const claims = DEMO_HOLDERS[persona];
      const r = await api("/api/wallet/issue", { holderPublicJwk: keys.publicJwk, claims });
      if (r.error) return logLine("Issuance failed: " + r.error, "bad");
      credential = { ...r.credential, issuerKid: me.issuerKid };
      saveCredential(credential!);
      logLine(`Wallet provisioned: ${persona} (credential held in browser)`, "ok");
    } finally { busy = false; }
  }

  async function selectFlow(f: string) {
    if (busy) return;
    // Leaving the Proof preview has to happen BEFORE the equality guard below.
    // The preview is client-side, so `me.flow` never moved while it was open —
    // meaning the tab you were nominally already on ("Browser wallet") compares
    // equal, returns early, and strands you in the preview with no way out.
    const wasPreviewing = proofPreview;
    proofPreview = false;
    if (f === me.flow) {
      if (wasPreviewing) logLine(`Back to the ${FLOW_LABEL[f] ?? f} workflow.`, "info");
      return; // nothing to switch server-side; keep any in-flight session intact
    }
    busy = true;
    try {
      const r = await api("/api/flow", { flow: f });
      if (r.error) return logLine(r.error, "bad");
      authSession = undefined; present = undefined; verification = undefined; intent = undefined; agentRun = undefined; didSettle = false;
      await refreshMe();
      if (me.identity !== "proof") { keys = await ensureHolderKeys(); credential = loadCredential(); }
      logLine(`Switched to the ${FLOW_LABEL[f] ?? f} workflow.`, "info");
    } finally { busy = false; }
  }

  async function startAuthorize() {
    if (!delegated && !selectedSku) return;
    busy = true; present = undefined; verification = undefined; intent = undefined; agentRun = undefined; didSettle = false;
    try {
      authSession = await api("/api/authorize/start", {
        sku: selectedSku, requestedClaims: requested, ttlSeconds: ttl,
        ...(delegated ? { budgetUsd } : {}),
      });
      logLine(
        delegated
          ? `Mandate-grant PROOF-REQUIRED issued · budget ${usd(authSession.payment.amount)} · ${authSession.requestedClaims.length} claims`
          : `PROOF-REQUIRED issued · ${authSession.requestedClaims.length} claims requested · payment ${usd(authSession.payment.amount)}`,
        "info",
      );
      if (proofIdentity) {
        logLine("Opening Proof hosted wallet…", "info");
        const w = window.open(authSession.authorizeUrl, "proof", "width=520,height=760");
        if (!w) { logLine("Popup blocked — redirecting this tab to Proof…", "info"); window.location.href = authSession.authorizeUrl; }
      }
    } finally { busy = false; }
  }

  async function approveLocal() {
    if (!credential || !keys || !authSession) return;
    busy = true;
    try {
      present = await presentInBrowser({
        privateJwk: keys.privateJwk, credential, query: authSession.dcql,
        nonce: authSession.nonce, audience: authSession.audience,
      });
      logLine(`Disclosed [${present.disclosed.join(", ")}] · withheld [${present.withheld.join(", ")}]`, "ok");
      await onVpToken(present.vpToken);
    } finally { busy = false; }
  }

  async function onVpToken(vpToken: string) {
    if (proofIdentity) {
      const decoded = await decodeDisclosed(vpToken);
      present = { disclosed: decoded.disclosed, withheld: [], missing: [], vpToken, subject: decoded.subject };
      logLine(`Proof returned a presentation disclosing [${decoded.disclosed.join(", ")}]`, "ok");
    }
    const r = await api("/api/authorize/complete", { vpToken });
    verification = r.verification ?? verification;
    if (r.error) { logLine(`Verification rejected: ${r.error}`, "bad"); return; }
    intent = r.intent;
    logLine(
      delegated
        ? `Standing mandate signed for ${intent?.principal?.email ?? intent?.principal?.sub} — agent may now spend up to ${usd(intent?.scope?.maxAmount)} autonomously`
        : `Presentation verified → HAM Intent signed for ${intent?.principal?.email ?? intent?.principal?.sub}`,
      "ok",
    );
    refreshMe();
  }

  async function runAgent() {
    if (!intent) return;
    busy = true;
    try {
      logLine("Agent transacting autonomously under the standing mandate (no human approval)…", "info");
      agentRun = await api("/api/agent/run", {});
      didSettle = (agentRun.purchases ?? []).some((p: any) => p.settled);
      for (const p of agentRun.purchases ?? []) {
        if (p.settled) logLine(`✓ ${p.name} ($${p.priceUsd}) settled — presigned mandate, no human in the loop`, "ok");
        else logLine(`✗ ${p.sku} denied (HTTP ${p.status}): ${p.reason ?? ""}${(p.violations?.length ? " — " + p.violations.join("; ") : "")}`, "bad");
      }
      logLine(`Budget: spent ${usd(agentRun.spentAtomic)} of ${usd(agentRun.capAtomic)} · ${usd(agentRun.remainingAtomic)} remaining`, "info");
      refreshOrders();
    } finally { busy = false; }
  }

  async function revokeMandate() {
    if (!intent) return;
    busy = true;
    try {
      const r = await api("/api/mandate/revoke", { reason: "revoked from wallet UI" });
      if (r?.revoked) {
        logLine("🔒 Mandate revoked — the merchant will now refuse any further spend against it.", "ok");
        agentRun = undefined;
        await refreshMe();
      } else {
        logLine(`Revoke failed: ${r?.error ?? "unknown"}`, "bad");
      }
    } finally { busy = false; }
  }

  async function pay() {
    if (!intent) return;
    busy = true;
    try {
      logLine(`Agent paying for ${selectedSku} via x402…`, "info");
      const r = await api("/api/buy", { sku: selectedSku });
      didSettle = r.settled?.state === "SETTLED";
      if (r.ok) logLine(`✓ ${selectedSku}: ${r.settled?.state ?? "authorized"}${r.settled?.txHash ? " · tx " + short(r.settled.txHash) : ""}`, "ok");
      else logLine(`✗ refused (HTTP ${r.status}): ${JSON.stringify(r.body?.violations ?? r.body?.error)}`, "bad");
      refreshOrders();
    } finally { busy = false; }
  }

  async function reset() {
    busy = true;
    try {
      // Invalidate any /api/me poll already in flight FIRST. One issued before
      // this call returns the pre-reset session, and landing afterwards it would
      // restore `intent`/`verification` — putting the Pay card and a lit-up
      // protocol flow right back, which reads as "Reset did nothing".
      meGen++;
      await api("/api/reset", {});
      authSession = undefined; present = undefined; verification = undefined;
      intent = undefined; agentRun = undefined; didSettle = false; pasted = "";
      // The Proof tab is client-side view state, so the server reset cannot
      // touch it: without this, Reset from that tab changes nothing on screen.
      proofPreview = false;
      // The browser-held credential is demo state too. Leaving it in place is
      // what made Reset look like a no-op: step 1 stayed green, the wallet card
      // stayed populated, and nothing visibly changed for anyone who had not
      // already gotten past authorization.
      if (me.identity !== "proof") {
        clearWallet();
        credential = undefined;
        keys = await ensureHolderKeys(); // fresh holder key, not the cleared one
      }
      // Clearing the transcript is part of "reset": a log still listing the
      // mandate you just signed is the loudest signal on screen that nothing
      // happened. (The merchant's order table deliberately survives — it is a
      // global ledger shared with every other visitor, not your session.)
      log = [];
      logLine("Reset — session cleared and the browser wallet emptied.", "info");
      await refreshMe();
    } finally { busy = false; }
  }
</script>

<header class="top">
  <div>
    <h1>Who is this? Says who? Did they authorize <i>this</i>?</h1>
    <p>Every business interaction with a person on the internet answers those three questions. An agent paying on your behalf has to answer them too — and the third one is the one today's payment rails skip. This demo makes all three visible.</p>
  </div>
  <div class="row">
    <span class="pill" title="x401 identity presentation · x402 payment rail · HAM authorization mandate">x401 · x402 · HAM</span>
    <span class="pill">mode <b style="color:var(--acc);margin-left:4px">{me.mode}</b></span>
    <span class="pill">agent <span class="mono">{short(me.agentWallet)}</span></span>
    <button class="ghost" onclick={reset}>Reset</button>
  </div>
</header>

{#if needsLogin}
  <div class="wrap">
    <div class="card" style="max-width:440px;margin:48px auto">
      <h2>🔒 Enter the demo</h2>
      <p class="note">This demo keeps a little state for each visitor, so it asks for a token first. If you were sent a link, the token below is yours to use.</p>
      <input
        type="password"
        bind:value={token}
        placeholder="Access token"
        onkeydown={(e) => e.key === 'Enter' && token.trim() && login()}
        style="width:100%;margin:10px 0;background:var(--chip);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:9px"
      />
      <button onclick={login} disabled={!token.trim()}>Unlock</button>

      {#if me.publicToken}
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
          <p class="note" style="margin:0 0 8px">
            Public demo — testnet only. Settlement is mocked and the agent wallet is a
            throwaway key, so nothing here can move real funds.
          </p>
          <code
            class="mono"
            style="display:block;user-select:all;background:var(--chip);border:1px solid var(--line);border-radius:8px;padding:8px;word-break:break-all;font-size:13px"
          >{me.publicToken}</code>
          <div class="row" style="margin-top:8px;gap:8px">
            <button class="ghost" onclick={() => copyUnlock("token")}>
              {copied === "token" ? "Copied ✓" : "Copy token"}
            </button>
            <button class="ghost" onclick={() => copyUnlock("link")}>
              {copied === "link" ? "Copied ✓" : "Copy unlock link"}
            </button>
          </div>
        </div>
      {/if}
    </div>
  </div>
{:else}
<div class="wrap">
  <ThreeQuestions {exhibit} />
  <StartHere proofLiveReady={me.proofLiveReady === true} exhibitAvailable={exhibit?.available === true} />
  <div class="flowbar">
    <span class="mut" style="font-size:12px">Wallet workflow</span>
    <div class="seg">
      {#each (me.flows ?? []) as f}
        {#if f === 'proof-hosted' && proofPreviewable}
          <!-- Not a disabled control. A live presentation needs the visitor's own
               identity verification, but the recorded credential behind this tab is
               real and worth walking through, so the tab opens it rather than
               greying out. Purely local state — no /api/flow call. -->
          <button
            class="seg-btn preview {proofPreview ? 'on' : ''}"
            disabled={busy}
            title="Walk through a genuine Proof-issued credential, re-verified live"
            onclick={() => (proofPreview = true)}
          >{FLOW_LABEL[f] ?? f} <span class="tag">real</span></button>
        {:else}
          <button
            class="seg-btn {me.flow === f && !proofPreview ? 'on' : ''}"
            disabled={busy || (f === 'proof-hosted' && !me.proofLiveReady)}
            title={f === 'proof-hosted' && !me.proofLiveReady ? 'A live Proof presentation needs your own Proof identity verification, so it is off on this deployment. (Operators: PROOF_CLIENT_ID + PROOF_CLIENT_SECRET with PROOF_MODE=live.)' : ''}
            onclick={() => selectFlow(f)}
          >{FLOW_LABEL[f] ?? f}</button>
        {/if}
      {/each}
    </div>
    <span class="mut" style="font-size:12px">
      {#if proofPreview}a real Proof credential · recorded, re-verified, and deliberately unspendable
      {:else if me.flow === 'self-issued'}you vouch for yourself · approve every purchase
      {:else if me.flow === 'proof-hosted'}Proof vouches for you · approve every purchase
      {:else}approve once, up front · the agent then buys on its own{/if}
    </span>
  </div>

  <div class="grid">
    <!-- LEFT: wallet + authorization -->
    <div class="col">
      {#if proofPreview}
      <ProofWalkthrough {exhibit} />
      {:else}
      <div class="card">
        <h2><span class="step">1</span> Wallet</h2>
        {#if proofIdentity}
          <p class="note">Proof-hosted: the credential lives in your <b>Proof</b> wallet. Selective disclosure happens on Proof's hosted flow (driven by <span class="mono">@proof.com/proof-vc-server</span>); we decode the returned presentation to visualize it.</p>
        {:else}
          <div class="row spread">
            <div class="row">
              <span class="mut">Persona</span>
              <select bind:value={persona}>
                {#each Object.keys(DEMO_HOLDERS) as email}<option value={email}>{email}</option>{/each}
              </select>
            </div>
            <button onclick={provision} disabled={busy}>{credential ? "Re-issue" : "Provision wallet"}</button>
          </div>
          {#if credential}
            <div class="divider"></div>
            <div class="row" style="gap:6px">
              {#each credential.claimNames as c}
                <span class="chip-claim" title="held, selectively disclosable">{c}: <b style="margin-left:4px">{String(DEMO_HOLDERS[persona]?.[c] ?? "•")}</b></span>
              {/each}
            </div>
            <p class="note" style="margin:10px 0 0">SD-JWT-VC held in this browser. Holder key bound via <span class="mono">cnf</span>; every claim is independently disclosable.</p>
          {/if}
        {/if}
      </div>

      <div class="card">
        {#if delegated}
          <h2><span class="step">2</span> Grant a standing mandate &amp; what to disclose</h2>
          <p class="note" style="margin:0 0 10px">Authorize <b>once</b>: the human's presentation signs a budget the agent then spends autonomously — no per-purchase approval. The signed Intent (allowlist + cap + expiry) is the standing authorization.</p>
          <div class="row spread">
            <div class="row"><span class="mut">Budget (USDC)</span><input type="number" step="0.25" bind:value={budgetUsd} min="0.25" style="width:100px" /></div>
            <span class="pill">expires in {Math.round((me.mandateTtl ?? 86400) / 3600)}h</span>
          </div>
          <p class="note" style="margin:8px 0 0">Scope: all catalog categories at Mock VeryGood-RX, up to the budget cap.</p>
        {:else}
          <h2><span class="step">2</span> Choose purchase &amp; what to disclose</h2>
          <div>
            {#each catalog as p}
              <div class="prod {p.sku === selectedSku ? 'sel' : ''}">
                <label class="row" style="gap:8px;cursor:pointer">
                  <input type="radio" name="sku" value={p.sku} bind:group={selectedSku} />
                  <span><b>{p.name}</b><br /><span class="mut" style="font-size:12px">{p.sku} · {p.category}</span></span>
                </label>
                <span class="pill">${p.priceUsd}</span>
              </div>
            {/each}
          </div>
        {/if}
        <div class="divider"></div>
        <div class="mut" style="margin-bottom:6px">Identity claims to request (DCQL):</div>
        <div class="row" style="gap:6px">
          {#each me.claimUniverse as c}
            <button type="button" class="chip-claim {requested.includes(c) ? 'on' : ''}" onclick={() => toggleClaim(c)}>{c}</button>
          {/each}
        </div>
        <div class="row spread" style="margin-top:12px">
          <div class="row"><span class="mut">TTL</span><input type="number" bind:value={ttl} min="60" style="width:90px" disabled={delegated} /><span class="mut">sec</span></div>
          <button onclick={startAuthorize} disabled={busy || (!proofIdentity && !credential)}>{delegated ? "Request mandate grant" : "Request authorization"}</button>
        </div>
      </div>

      {#if authSession}
        <PaymentAuthCard payment={authSession.payment} bound={verification ? verification.txDataBound : undefined} />

        <div class="card fade-in">
          <h2><span class="step">3</span> Consent &amp; selective disclosure</h2>
          {#if !proofIdentity}
            <div class="mut" style="margin-bottom:6px">The wallet will reveal only:</div>
            <div class="row" style="gap:6px">
              {#each previewDisclose as c}<span class="chip-claim claim-disclosed">{c}</span>{/each}
              {#each previewMissing as c}<span class="chip-claim" style="border-color:var(--warn);color:var(--warn)">{c} (missing)</span>{/each}
            </div>
            {#if previewWithheld.length}
              <div class="mut" style="margin:10px 0 6px">Withheld (held but not shared):</div>
              <div class="row" style="gap:6px">{#each previewWithheld as c}<span class="chip-claim claim-withheld">{c}</span>{/each}</div>
            {/if}
            <button style="margin-top:12px" onclick={approveLocal} disabled={busy || !!present}>Approve &amp; present</button>
          {:else}
            <p class="note">Approve the presentation in the Proof window. If the demo's callback is registered as your redirect URI it returns automatically; otherwise copy the URL Proof lands on (it contains <span class="mono">#vp_token=…</span>) and paste it below.</p>
            <div style="margin:8px 0">
              <proof-verify-id bind:this={proofBtn} theme="primary" size="medium"></proof-verify-id>
              <span class="mut" style="font-size:12px;margin-left:8px">official Proof button (proof-vc-web), if the popup was blocked</span>
            </div>
            <textarea
              bind:value={pasted}
              placeholder="Paste the redirect URL (…#vp_token=…) or the raw vp_token"
              rows="3"
              style="width:100%;margin-top:8px;background:var(--chip);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:8px;font-family:ui-monospace,monospace;font-size:12px"
            ></textarea>
            <button style="margin-top:8px" onclick={submitPasted} disabled={busy || !pasted.trim()}>Submit presentation</button>
            {#if present}
              <div class="row" style="gap:6px;margin-top:8px">{#each present.disclosed as c}<span class="chip-claim claim-disclosed">{c}</span>{/each}</div>
            {/if}
          {/if}
        </div>
      {/if}

      {#if intent && delegated}
        <div class="card fade-in">
          <h2><span class="step">4</span> Autonomous agent</h2>
          <p class="note" style="margin:0 0 10px">The standing mandate is signed. The agent now buys over x402 with <b>no further human approval</b> — the presigned identity is the authorization. The merchant enforces the cumulative cap, so an over-budget buy is denied on its own.</p>
          <div class="row spread" style="margin-bottom:10px">
            <span class="pill">cap {usd(intent?.scope?.maxAmount)}</span>
            {#if agentRun}
              <span class="pill">spent {usd(agentRun.spentAtomic)}</span>
              <span class="pill">left {usd(agentRun.remainingAtomic)}</span>
            {/if}
            {#if revoked}<span class="pill" style="color:var(--bad);border-color:var(--bad)">🔒 revoked</span>{/if}
          </div>
          {#if revoked}
            <p class="note" style="margin:0 0 10px;color:var(--warn)">This mandate is revoked. The agent may still hold the signed Intent, but the merchant now refuses every spend — run the agent to see it denied.</p>
          {/if}
          <div class="row" style="gap:8px">
            <button class="alt" onclick={runAgent} disabled={busy}>Run agent (autonomous buys)</button>
            <button class="ghost" onclick={revokeMandate} disabled={busy || revoked} title="Kill this mandate before its expiry">{revoked ? "Revoked" : "Revoke mandate"}</button>
          </div>
          {#if agentRun}
            <div class="divider"></div>
            {#each agentRun.purchases as p}
              <div class="prod">
                <span><b>{p.name ?? p.sku}</b><br /><span class="mut" style="font-size:12px">{p.sku}{p.category ? " · " + p.category : ""}</span></span>
                <span class="pill" style={p.settled ? "color:var(--ok)" : "color:var(--warn)"}>{p.settled ? "settled $" + p.priceUsd : "denied"}</span>
              </div>
            {/each}
          {/if}
        </div>
      {:else if intent}
        <div class="card fade-in">
          <h2><span class="step">4</span> Pay</h2>
          <p class="note" style="margin:0 0 10px">Identity + payment authorized. The agent now settles <b>{selectedProduct?.name}</b> ({usd(authSession?.payment?.amount)}) over x402 — gated by the signed Intent.</p>
          <div class="row" style="gap:8px">
            <button class="alt" onclick={pay} disabled={busy || revoked}>Pay {usd(authSession?.payment?.amount)} via x402</button>
            <button class="ghost" onclick={revokeMandate} disabled={busy || revoked} title="Kill this mandate before its expiry">{revoked ? "Revoked" : "Revoke mandate"}</button>
          </div>
          {#if revoked}<p class="note" style="margin:8px 0 0;color:var(--warn)">Revoked — the merchant will refuse this payment.</p>{/if}
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

      <MerchantOrders {orders} />
    </div>

    <!-- RIGHT: flow + merchant -->
    <div class="col">
      <!-- The real credential outranks everything else here: it is the actual
           contribution, the flow rail is inert until you press something, and
           orders only get interesting after a purchase. In the Proof tab the
           walkthrough on the left supersedes it, so it drops out entirely. -->
      {#if !proofPreview}<ProofExhibit {exhibit} />{/if}
      <!-- In the Proof tab this rail is the ONLY card in the right column (the
           exhibit is superseded by the walkthrough, and the verifier/mandate
           cards are suppressed), while the walkthrough on the left runs long. So
           it follows you down rather than leaving a tall empty column. -->
      <div class="card {proofPreview ? 'sticky-rail' : ''}">
        <h2>Protocol flow</h2>
        <FlowViz steps={proofPreview ? proofSteps : steps} />
      </div>
      <!-- In the Proof tab, suppress the verification + Intent cards: they belong
           to YOUR interactive session, and a signed mandate sitting beside a
           walkthrough whose punchline is "this produces no mandate" reads as if
           the recording issued it. -->
      <MerchantPanel
        intent={proofPreview ? undefined : intent}
        verification={proofPreview ? undefined : verification}
      />
    </div>
  </div>
</div>
{/if}

