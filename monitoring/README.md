# `monitoring/` — JWKS watchdog

`jwks-watchdog.js` is the off-chain early-warning that makes the verifier's 7-day signing-key rotation timelock actually useful. A contract can't fetch Twitch's JWKS, so this script does, and reconciles it against the deployed `TwitchJWTVerifier`.

## What it checks (each run)

1. Fetches `https://id.twitch.tv/oauth2/keys`.
2. For every `kid` the verifier already knows, confirms its **onchain modulus still matches the live JWKS** (a mismatch ⇒ Twitch rotated ⇒ queue a rotation). Flags `kid="1"` disappearing.
3. Flags a **new Twitch kid** the verifier doesn't have yet (rotate during the overlap window).
4. Reads the verifier's **`pendingKeyFor(kid)`**: if a rotation is **queued**, it compares the pending modulus to the live JWKS. A mismatch is **CRITICAL** — likely a malicious key, and the `guardian` must `cancelKey()` before the timelock elapses. This is the teeth behind `KEY_TIMELOCK`.

## Run

```bash
npm run watchdog
# or:
node monitoring/jwks-watchdog.js
```

Prints one JSON line and sets the **exit code**: `0` ok · `1` warn · `2` critical · `3` error. Wire the exit code to your alerting.

Cron (daily) with a Slack/email hook on non-zero:

```cron
0 * * * *  cd /path/to/socialtwin-protocol && node monitoring/jwks-watchdog.js || notify "JWKS watchdog: $?"
```

## Config (env, all optional — default to the live v1.3 stack)

| Var | Default |
|---|---|
| `VERIFIER` | `0xBDfC552469f11843802BCD7ec9a8372c8020fee8` |
| `GUARDIAN` | `0xD1EC8245c8850A151843ce8a3AFdca3b19747706` (named in alerts as who must `cancelKey`) |
| `BASE_RPC_URL` | falls back to `base-rpc.publicnode.com`, then `mainnet.base.org` |

It reads the verifier's `modulusOf`/`pendingKeyFor` live, so it stays correct across rotations with no hardcoded modulus to maintain. Not in the spend path — purely an alarm.
