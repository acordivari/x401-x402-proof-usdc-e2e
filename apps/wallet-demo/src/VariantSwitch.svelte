<script lang="ts">
  /**
   * The one control both variants share: a slim strip above each app's own
   * header. It sits outside both apps on purpose, so the July UI underneath is
   * byte-for-byte what shipped in July rather than July-plus-a-new-button.
   */
  import { switchVariant, type Variant } from "./variant";

  let { variant }: { variant: Variant } = $props();
</script>

<div class="vstrip" role="navigation" aria-label="Demo variant">
  <span class="lbl">Variant</span>
  <div class="seg">
    <button class="seg-btn {variant === 'latest' ? 'on' : ''}" onclick={() => variant !== "latest" && switchVariant("latest")}>
      Latest <span class="mut-tag">Oct 2026</span>
    </button>
    <button class="seg-btn {variant === 'july' ? 'on' : ''}" onclick={() => variant !== "july" && switchVariant("july")}>
      July 2026
    </button>
  </div>
  <span class="hint">
    {#if variant === "july"}
      The July 2026 build, UI and flows as shipped: hosted redirect and paste-back, a sealed-challenge payment binding, a server-signed HAM mandate.
    {:else}
      Proof's current x401 stack: Cloud Wallet handoff, signed requests, Sign Transactions templates, x402-paid presentations.
    {/if}
  </span>
</div>

<style>
  .vstrip {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: 6px 24px; font-size: 12px;
    background: var(--chip); border-bottom: 1px solid var(--line);
  }
  .lbl { color: var(--mut); text-transform: uppercase; letter-spacing: 0.08em; font-size: 10.5px; font-weight: 700; }
  .seg-btn { padding: 4px 10px; font-size: 12px; }
  .mut-tag { font-weight: 600; opacity: 0.75; margin-left: 4px; font-size: 11px; }
  .hint { color: var(--mut); min-width: 0; }
  @media (max-width: 640px) { .vstrip { padding: 6px 16px; } .hint { flex-basis: 100%; } }
</style>
