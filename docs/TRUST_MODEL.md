# Trust model

What you have to trust, what you don't, and why.

## What you trust

| Party | What they can do if compromised | What stops compromise |
|---|---|---|
| **The identity provider (Twitch)** | Forge identity for any user → drain any twin | Twitch's enterprise security; standard CA-tier diligence on RSA keys |
| **Attestor operator(s)** | Sign arbitrary attestations → drain any twin bound to this verifier | Key in HSM / TEE; multi-attestor 1-of-N reduces blast radius |
| **Base sequencer + Ethereum L1** | Censor or reorder transactions | Base's L2 trust assumptions; ultimately Ethereum L1 |
| **The user's wallet** | Sign txs the user didn't intend | Standard wallet hygiene; CBSW uses biometric per transaction |
| **The user's browser** | Show malicious dApp UI | URL bar awareness; bookmarks; phishing prevention |

## What you don't trust

| Party | Why irrelevant |
|---|---|
| Any submitter of `execute()` | `msg.sender` is not in the action hash; funds go to `target` regardless |
| The Twitch app's client_secret | It's a value to authenticate the OAuth client; doesn't grant signing power |
| Any single witness / oracle / Reclaim node | Not used — the protocol doesn't rely on ZK-TLS in this configuration |
| The factory deployer | After deploy, deployer has no privileges |
| The contract authors | After deploy, contracts are immutable |
| Indexers / RPC providers | Read-only roles; users can self-host or use any provider |

## The compromise hierarchy

If you draw a line through "what compromises this user's funds":

```
              ┌────────────────────────────────────┐
LARGEST       │ Twitch's RSA private key            │   compromises everyone
RADIUS        │ leaks (catastrophic)                │   on every chain everywhere
              └────────────────────────────────────┘
                              │
                              ▼
              ┌────────────────────────────────────┐
              │ Attestor signing key                │   compromises every twin
              │ compromised                         │   bound to this verifier
              └────────────────────────────────────┘
                              │
                              ▼
              ┌────────────────────────────────────┐
              │ User authorizes a malicious dApp    │   compromises this user
              │ via "Sign in with Twitch"           │   one transaction
              └────────────────────────────────────┘
                              │
                              ▼
              ┌────────────────────────────────────┐
SMALLEST      │ User's Twitch password leaks        │   compromises this user
RADIUS        │ (account takeover)                  │   until they recover
              └────────────────────────────────────┘
```

Each level above compromises every level below. The protocol concerns itself only with what's on this chain.

## Mitigations by level

### Twitch key leak
Out of scope for this protocol. Same blast radius as "all Sign in with Twitch is broken." If Twitch detects this, they rotate; we follow with a new verifier. This is the lowest-probability, highest-impact event.

### Attestor key leak
The attestor's monitoring is the only signal. See [`KEY_MANAGEMENT.md`](./KEY_MANAGEMENT.md) for the response runbook. Damage is bounded by how fast the rotation completes, not by some inherent property of the protocol.

Reducing the probability:
- HSM/TEE storage
- 1-of-N federation
- Continuous anomaly detection
- Periodic planned rotation

### Phishing
The user's first line of defense. The protocol cannot help if the user clicks Authorize on a malicious dApp. Mitigations:
- Bookmark canonical dApp URLs
- Don't follow links from emails / DMs into dApps
- Verify the URL bar shows `id.twitch.tv` during OAuth
- Verify the Twitch consent screen shows the expected app name

### User account compromise
Same as having someone steal your wallet. Protocol can't recover. Mitigations:
- Strong unique passwords
- 2FA
- Don't reuse credentials

## What this is NOT

- **Self-custodial in the traditional sense.** The user doesn't hold a private key for the twin. They hold a Twitch account. If they lose that, they lose the twin.
- **Censorship-resistant against Twitch.** Twitch can refuse to authenticate a user, which makes the twin unspendable. We accept this; the same trade exists for any "sign in with X" service.
- **Anonymous.** Twin addresses are deterministically derived from public Twitch user IDs. Anyone can scan a Twitch handle to its twin address and watch the funds.

If any of these are dealbreakers for your use case, the SocialTwin model is wrong for you. Use a standard self-custodial wallet.

## What this IS

- **Address-from-handle.** Send to `@streamer` without knowing their wallet.
- **Receive-without-wallet.** No setup required for the recipient.
- **One-click claim.** Sign in with Twitch + biometric, you're done.
- **Permissionless.** Anyone can run an attestor; anyone can deploy a new factory; anyone can build a sender or recipient dApp.

The protocol is optimized for tipping, creator rewards, contest payouts, and similar "low-friction directed value" use cases. It is intentionally NOT a replacement for self-custodial wallets in higher-stakes use cases.
