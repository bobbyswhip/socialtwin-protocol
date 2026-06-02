> **⚠️ Superseded (v1.1, post-audit):** This document predates the audit response and describes the earlier **attestor / off-chain-signer** model, which was **removed**. The deployed protocol verifies Twitch JWTs **entirely onchain** (`TwitchJWTVerifier`), with a two-phase abandoned-funds rescue and a timelocked `aud` allowlist. For the current design see [`README.md`](../README.md) and [`AUDIT_RESPONSE.md`](../AUDIT_RESPONSE.md); the onchain-JWT review is in [`SECURITY_REVIEW.md`](../SECURITY_REVIEW.md). Retained for historical context.

# Adding identity providers

The protocol is IdP-agnostic. The onchain contracts (`TwinFactory`, `TwinAccount`, `AttestorVerifier`) don't know anything about Twitch — they just verify an ECDSA signature over `(userId, actionHash, oauthExchangeEpoch)`. Everything IdP-specific lives in the attestor backend.

To add a new provider, you implement the `IdentityProvider` interface in [`attestor/src/providers/provider.ts`](../attestor/src/providers/provider.ts) and register it in `index.ts`. That's it.

## OIDC-compliant providers (easy mode)

Most major IdPs implement OIDC: they issue signed id_tokens at `/oauth2/token` and publish their public keys at a JWKS endpoint. Adapt `attestor/src/providers/twitch.ts` like so:

### Example: Google

```ts
// attestor/src/providers/google.ts
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { IdentityProvider } from "./provider";

const ISSUER = "https://accounts.google.com";
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

export class GoogleProvider implements IdentityProvider {
  readonly name = "google";
  private jwks = createRemoteJWKSet(new URL(JWKS_URL));

  constructor(private clientId: string, private clientSecret: string) {}

  authorizeUrl(opts: {
    redirectUri: string; state: string; codeChallenge: string; nonce?: string;
  }): string {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: opts.redirectUri,
      scope: "openid",
      state: opts.state,
      code_challenge: opts.codeChallenge,
      code_challenge_method: "S256",
      prompt: "consent", // always show the consent screen
    });
    if (opts.nonce) params.set("nonce", opts.nonce);
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeAndExtract(opts: { code: string; codeVerifier: string; redirectUri: string }) {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code: opts.code,
        grant_type: "authorization_code",
        redirect_uri: opts.redirectUri,
        code_verifier: opts.codeVerifier,
      }),
    });
    if (!res.ok) throw new Error(`Google token exchange: ${res.status}`);
    const { id_token } = await res.json();
    const { payload } = await jwtVerify(id_token, this.jwks, {
      issuer: ISSUER, audience: this.clientId,
    });

    // Google's sub is a string of digits, but the value space exceeds uint64.
    // Two options:
    //   (a) Use a separate registry that allocates uint64 ids from the Google sub.
    //   (b) Derive a stable uint64 from sub: BigInt('0x' + sha256(sub).slice(0,16)).
    // We use (b) here; document this choice prominently in your fork's README.
    const sub = String(payload.sub);
    const hash = require("crypto").createHash("sha256").update(sub).digest("hex");
    const userId = BigInt("0x" + hash.slice(0, 16));

    return {
      userId,
      preferredUsername: (payload as any).email?.split("@")[0],
      picture: (payload as any).picture,
    };
  }
}
```

Then in `attestor/src/index.ts`:

```ts
import { GoogleProvider } from "./providers/google";
registry.register(new GoogleProvider(cfg.google.clientId, cfg.google.clientSecret));
```

The attestor route URLs auto-expand to `/attest/google/start` and `/attest/google/callback`.

### Other OIDC providers — quick reference

| Provider | Issuer | Discovery |
|---|---|---|
| Twitch | `https://id.twitch.tv/oauth2` | `https://id.twitch.tv/oauth2/.well-known/openid-configuration` |
| Google | `https://accounts.google.com` | `https://accounts.google.com/.well-known/openid-configuration` |
| Apple | `https://appleid.apple.com` | `https://appleid.apple.com/.well-known/openid-configuration` |
| Microsoft | `https://login.microsoftonline.com/{tenant}/v2.0` | discovery via `{tenant}` |
| Discord | `https://discord.com` | partial OIDC; check current docs |

## Non-OIDC providers (harder)

Providers that only do plain OAuth 2.0 (not OIDC) don't issue signed id_tokens. The user identity comes from a `/me` HTTP endpoint that responds in plain JSON over TLS. The attestor can verify the OAuth handshake, but the *content* of the `/me` response is just an HTTPS body — no signature.

### Path 1: trust the attestor

If the attestor is already the trust root for ECDSA-signing identity attestations, just have it call `/me` with the access token and pick `id` from the response. The dApp's view doesn't change. This is the simplest path and is appropriate for most cases — you've already accepted the attestor as a trust root.

```ts
async exchangeAndExtract(...) {
  const { access_token } = await exchangeCode(...);
  const me = await fetch("https://api.twitter.com/2/users/me", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const { data } = await me.json();
  return { userId: BigInt(data.id), preferredUsername: data.username };
}
```

### Path 2: cryptographic proof of the `/me` response

If you want to weaken the attestor's trust burden (so an attestor compromise doesn't allow forging arbitrary identities), you need an external attestation of the `/me` response:

- **Reclaim Protocol** — ZK-TLS proof of an HTTPS response. The attestor verifies the proof before signing. Reintroduces a third-party dependency but distributes trust.
- **TEE** — run the OAuth + `/me` call inside an enclave. The enclave's attestation proves the code that produced the result. Cleaner if you control the TEE.
- **TLSNotary** — similar to Reclaim, more research-y.

Cost: significant engineering effort. Reward: the attestor key alone is insufficient to forge identity attestations.

Most production systems pick Path 1. Only do Path 2 if your threat model genuinely requires defeating attestor compromise without IdP cooperation.

## Provider naming convention

Use lowercase single-word names: `twitch`, `google`, `apple`, `discord`, `github`, `twitter`. The name appears in URL paths and attestation payloads, so keep it stable across deployments.

If you support multiple IdPs simultaneously, twin addresses MUST be partitioned by IdP — otherwise a userId `12345` from Twitch and a derived `12345` from Google could collide. Use a different salt domain per provider:

```solidity
// In a new TwinFactory variant:
string internal constant DOMAIN = "SocialTwin:google:v1";
```

Or use one factory per IdP. Simpler.
