# Going live on x401.thisisandrew.me

**Short version:** the live x401 verifier runs as a second, gated Render service on `x401.thisisandrew.me`. It takes 6 steps, about 30 minutes, and one email click. The public demo stays as it is: open, offline, emulated Proof.

Why a second service rather than flipping the public one: `LATEST_PROOF_MODE=live` refuses to boot with `DEMO_OPEN_ACCESS` or `DEMO_PUBLIC_TOKEN`. An ungated live verifier would let any visitor start real Proof presentations and spend the verifier's x402 wallet on signatures. Why a domain you own: Proof refuses to enroll a public-suffix host like `onrender.com`, and the enrollment email has to be on the metadata document's domain. `thisisandrew.me` meets both, and its Proton mail can receive the activation link.

## What you need first

- **A mailbox on the domain.** Any address on `thisisandrew.me` works; the steps use `admin@thisisandrew.me`. Proton is the domain's MX today.
- **A Fairfax (sandbox) Proof identity** to approve presentations with — the one your recorded exhibit came from.
- **Optional:** a Base Sepolia wallet with testnet USDC from faucet.circle.com, so the merchant can pay Proof for each presentation's signatures over x402. Without it, Proof has to bill a card on the account, or verification fails closed on the `402`.

## Steps

1. **Generate the verifier key.** Keep this file out of the repo.
   ```bash
   openssl ecparam -name prime256v1 -genkey -noout -out private-key.pem
   ```
   Its public half becomes the `jwks` in your metadata document. The private half signs every request object, plus the client assertion that buys back signatures.

2. **Create the service.** In Render, sync the blueprint (`render.yaml`). It now defines `agentic-payments-live` next to the public demo. When prompted for the `sync: false` values, fill in:
   - `PROOF_VERIFIER_KEY`: the full PEM contents. Escaped `\n` newlines are fine.
   - `PROOF_LOGIN_HINT`: your Fairfax sandbox email. Optional, since anyone using the service can type theirs in the UI.
   - `PROOF_VERIFIER_EVM_KEY`: optional, the funded Base Sepolia key.

   Render generates `DEMO_AUTH_TOKEN`, which is how you get past the gate; read it in the dashboard. The service won't boot without `PROOF_VERIFIER_KEY`, by design.

3. **Point the subdomain.** In Cloudflare DNS for `thisisandrew.me`, add a `CNAME` named `x401` targeting the new service's `<name>.onrender.com` host. Set it to **DNS only** (grey cloud) so Render can issue the TLS certificate. Then confirm the domain under the service's *Custom Domains* in Render. The apex site on Netlify is untouched.

4. **Check what Proof will fetch.** Load the page once first to wake the service, since the free plan cold-starts in ~50 s. Then:
   ```bash
   curl -s https://x401.thisisandrew.me/.well-known/proof-client.json | jq
   ```
   Expect `client_id` to be that exact URL, `redirect_uris` to be `["https://x401.thisisandrew.me", "https://api.fairfax.proof.com/.well-known/agents-trust-list"]`, and one public ES256 key.

5. **Enroll.** Do this once, with the same key file:
   ```bash
   npx @proof.com/proof-vc-server enroll https://x401.thisisandrew.me/.well-known/proof-client.json \
     --email admin@thisisandrew.me --key private-key.pem --environment sandbox
   ```
   Click the activation link Proof sends to that inbox.

6. **Present.** Open `https://x401.thisisandrew.me`, unlock it with the token, and choose **Latest → Approve each purchase → Proof Cloud Wallet**. Enter your sandbox email if you didn't set a default, then press *Agent: GET*. Approve on Proof's screen. Proof posts the presentation back to the return channel, and the agent completes 401 → token → 402 → 200. The *Merchant · what was proven* card should then show **Proof Development Root CA** as the trust anchor, rather than the pinned local issuer.

## If something fails

| Symptom | Likely cause |
|---|---|
| Service won't boot: `LATEST_PROOF_MODE=live needs …` | A missing secret, an http `PUBLIC_ORIGIN`, or open access or a published token left set. The message names which. |
| `enroll` returns `public_suffix_host` / `email_domain_mismatch` | Enrolling an `onrender.com` URL, or an email off `thisisandrew.me` |
| Handoff returns `400 payload is invalid` | Not enrolled yet, or the CIMD key differs from `PROOF_VERIFIER_KEY` (regenerated key, stale enrollment) |
| Handoff returns a link, but Proof asks for the wrong person | `login_hint`: enter your Fairfax sandbox email in step 1 of the UI |
| Verification refused: `detached signatures require an x402 payment` | No `PROOF_VERIFIER_EVM_KEY` and no card on the Proof account |

## What I couldn't confirm in advance

- **Whether the sandbox handoff requires `login_hint`.** The API reference lists it as a request-object claim, but Proof's own samples omit it. The service sends it whenever it has one.
- **The per-presentation price.** Proof doesn't publish one, so fund the wallet with a few testnet USDC.
- **Whether native `navigator.credentials.get` reaches a Proof credential.** The Digital Credentials API path is wired, but I found no wallet that answers it today.

Once step 6 succeeds, I'd record that presentation as a second exhibit — the first x402-paid, Proof-verified one — so the public demo can show it without going live itself.
