/**
 * Which UI variant this page load renders.
 *
 *   latest : the current build, aligned with Proof's newest x401 stack
 *   july   : the July 2026 UI, preserved as shipped so it can still be shown
 *
 * Resolution order: `?variant=` in the URL (so a link can pin one), then the
 * visitor's last choice, then `latest`. Switching is a full navigation rather
 * than an in-place swap: the July app registers window listeners and polling
 * intervals it never tears down, and each variant registers Proof's custom
 * elements, which a page can only define once. A fresh document avoids both.
 */
export type Variant = "latest" | "july";

const KEY = "ap.variant";
const isVariant = (v: unknown): v is Variant => v === "latest" || v === "july";

export function resolveVariant(): Variant {
  const fromUrl = new URLSearchParams(location.search).get("variant");
  if (isVariant(fromUrl)) {
    remember(fromUrl);
    return fromUrl;
  }
  try {
    const saved = localStorage.getItem(KEY);
    if (isVariant(saved)) return saved;
  } catch {
    // storage blocked (private window, preview): fall through to the default
  }
  return "latest";
}

export function switchVariant(next: Variant): void {
  remember(next);
  const url = new URL(location.href);
  url.searchParams.set("variant", next);
  url.hash = ""; // a fragment here is a spent vp_token or token link, never worth carrying
  location.assign(url.toString());
}

function remember(v: Variant): void {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    // the URL still carries the choice for this load
  }
}
