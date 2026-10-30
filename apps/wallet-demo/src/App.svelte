<script lang="ts">
  /**
   * Variant shell. Each variant is loaded with a dynamic import so a page only
   * ever evaluates one of them: they pin different Proof web-component builds,
   * and a custom element name can be defined once per document.
   *
   * One more route: a handoff link (`/emulator/proof/wallet/:id`) opens the
   * emulated Proof Cloud Wallet page, which belongs to neither variant.
   */
  import VariantSwitch from "./VariantSwitch.svelte";
  import { resolveVariant } from "./variant";

  const hostedWallet = location.pathname.startsWith("/emulator/proof/wallet/");
  const variant = resolveVariant();
  // One loader per view, kept as separate functions on purpose. Vite wraps each
  // dynamic import in a preload call that also loads that chunk's CSS; written
  // as a ternary (or if/return chain), the minifier folds the three calls into
  // ONE wrapper carrying ONE chunk's dependencies, and the other views render
  // without their component styles.
  const views = {
    hosted: () => import("./variants/latest/HostedWallet.svelte"),
    july: () => import("./variants/july/JulyApp.svelte"),
    latest: () => import("./variants/latest/LatestApp.svelte"),
  };
  const load = views[hostedWallet ? "hosted" : variant]();
</script>

{#if !hostedWallet}<VariantSwitch {variant} />{/if}
{#await load then mod}
  <mod.default />
{:catch err}
  <div class="wrap"><div class="card"><h2>Couldn't load this variant</h2><p class="note">{String(err)}</p></div></div>
{/await}
