<script lang="ts">
  /**
   * The EMULATED Proof Cloud Wallet page — what a handoff `request_uri` opens.
   *
   * Proof's real one lives at app.proof.com, where the person signs in with a
   * biometric and Proof holds the key. Offline, this page plays that part with
   * the same demo wallet as the main page (same origin, same browser-held
   * credential), and then does what the real one does: POSTs the credential
   * result to the intermediary's `return_uri`. Being a relayed fulfillment,
   * there is no invoking origin to check — the signature, client_id, audience
   * and expiry still are.
   */
  import { onMount } from "svelte";
  import { api } from "./lib/api";
  import { holderKeys, loadCredential, type HeldCredentialV1 } from "./lib/holder";
  import WalletSheet from "./lib/WalletSheet.svelte";
  import {
    answerDcApiRequest,
    previewDcApiRequest,
    type ClientIdMetadataDocument,
    type DcApiPreview,
    type Jwk,
  } from "@agentic-payments/credentials/browser";

  const id = location.pathname.split("/").filter(Boolean).pop() ?? "";
  let me = $state<any>(undefined);
  let handoff = $state<any>(undefined);
  let credential = $state<HeldCredentialV1 | undefined>(undefined);
  let preview = $state<DcApiPreview | undefined>(undefined);
  let metadata: ClientIdMetadataDocument | undefined;
  let error = $state<string | undefined>(undefined);
  let done = $state(false);
  let busy = $state(false);

  onMount(() => { void load(); });

  async function load() {
    try {
      me = await api("/api/latest/me");
      const r = await fetch(`/emulator/proof/handoff/${encodeURIComponent(id)}`);
      handoff = await r.json();
      if (!r.ok) throw new Error(handoff.error ?? `handoff ${r.status}`);
      if (handoff.delivered) { done = true; return; }
      credential = loadCredential(me?.issuer?.kid);
      const cid = JSON.parse(atob(handoff.request.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).client_id as string;
      metadata = (await (await fetch(new URL(cid).origin === location.origin ? new URL(cid).pathname : cid)).json()) as ClientIdMetadataDocument;
      preview = await previewDcApiRequest({ request: handoff.request, metadata, audience: me.verifier.walletAudience });
    } catch (err) {
      error = String((err as Error).message ?? err);
    }
  }

  async function approve() {
    if (!credential || !metadata) return;
    busy = true;
    try {
      const keys = await holderKeys();
      const ans = await answerDcApiRequest({
        request: handoff.request,
        metadata,
        audience: me.verifier.walletAudience,
        credential: credential.compact,
        holderPrivateJwk: keys.privateJwk as Jwk,
        ...(me.verifier.signatureBilling === "x402"
          ? { detach: async (rid: string, sigs: any) => { await api("/emulator/proof/wallet/signatures", { id: rid, ...sigs }); } }
          : {}),
      });
      const back = await fetch(handoff.return_uri, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ans.result) });
      if (!back.ok) throw new Error(`return channel answered ${back.status}`);
      await fetch(`/emulator/proof/handoff/${encodeURIComponent(id)}/delivered`, { method: "POST" });
      done = true;
      try { if (window.opener) setTimeout(() => window.close(), 1800); } catch {}
    } catch (err) {
      error = String((err as Error).message ?? err);
    } finally { busy = false; }
  }
</script>

<div class="hosted">
  <div class="brand"><span class="mark">◈</span> Proof Cloud Wallet <span class="badge b-mut">emulated</span></div>
  <p class="note" style="margin:0 0 14px">Offline stand-in for Proof's hosted wallet, reached through an x401 handoff. On the real one you'd sign in with a biometric and Proof would hold your key.</p>
  {#if done}
    <div class="card"><h2>Sent ✓</h2><p class="note" style="margin:0">Your presentation went back through the return channel. You can close this window, since the demo picks it up from here.</p></div>
  {:else if error}
    <div class="card"><h2>Can't answer this request</h2><p class="note" style="margin:0;color:var(--bad)">{error}</p></div>
  {:else if !credential && me}
    <div class="card"><h2>No credential in this wallet</h2><p class="note" style="margin:0">Issue one in the demo first (step 1). This emulated wallet shares the demo's browser storage.</p></div>
  {:else if preview}
    <WalletSheet
      walletLabel="Proof Cloud Wallet · emulated"
      verifierName={preview.clientName}
      clientId={preview.claims.client_id}
      checks={[
        { label: "signed by a key in the verifier's metadata", ok: true },
        { label: "addressed to this wallet", ok: true },
        { label: "relayed — no invoking origin to check", ok: true },
      ]}
      held={credential?.claims}
      disclose={preview.disclose.map((p) => p.join("."))}
      terms={preview.terms}
      billing={me?.verifier?.signatureBilling}
      {busy}
      approveLabel="Approve & send back"
      onapprove={approve}
    />
  {:else}
    <p class="mut">Loading the request…</p>
  {/if}
</div>

<style>
  .hosted { max-width: 520px; margin: 0 auto; padding: 24px 16px 48px; }
  .brand { font-weight: 800; font-size: 16px; margin-bottom: 6px; display: flex; align-items: center; gap: 8px; }
  .mark { color: var(--ok); font-size: 20px; }
</style>
