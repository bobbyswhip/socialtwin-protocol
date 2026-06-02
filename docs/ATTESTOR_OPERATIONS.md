# Running an attestor

The attestor is a small Node service that:
1. Receives a redirect from a dApp.
2. Drives the OAuth flow with the chosen IdP.
3. Verifies the resulting id_token.
4. Signs an ECDSA attestation that the onchain `AttestorVerifier` accepts.
5. Bounces the user back to the dApp.

Reference implementation at [`../attestor/`](../attestor/).

## Minimum operational requirements

| | |
|---|---|
| Compute | 1 vCPU / 512 MB. The service is mostly idle; even high traffic is fine on a t4g.nano. |
| Persistence | None. The service is stateless — all OAuth round-trip state is in signed JWT cookies. |
| Network | HTTPS endpoint with a valid TLS cert. IdP redirect URLs MUST point to this host. |
| Time | NTP-synced clock. A drift >60s starts rejecting attestations (`MAX_CLOCK_SKEW`). |
| Secrets | One ECDSA private key (`ATTESTOR_PRIVATE_KEY`). One symmetric HMAC secret (`STATE_HMAC_SECRET`). IdP client credentials (e.g., `TWITCH_CLIENT_SECRET`). |

## Deploy with Docker

```bash
cd attestor
docker build -t socialtwin-attestor .
docker run -d --name attestor \
  -p 4001:4001 \
  --env-file .env \
  socialtwin-attestor
```

Or use the Dockerfile as a starting point for ECS / Cloud Run / Fly / Railway.

## Critical: the signing key

The ECDSA private key (`ATTESTOR_PRIVATE_KEY`) is the highest-impact secret in the system. Leakage means an attacker can sign arbitrary attestations and drain every twin bound to this verifier.

### Storage options, ranked

1. **HSM** (AWS CloudHSM, GCP Cloud KMS, Azure Key Vault). The private key never leaves the appliance; the attestor sends digests in, gets signatures out. Slowest but most secure.
2. **AWS Nitro Enclave** (or similar TEE). Key is sealed to the enclave; attestor process holds it only in TEE memory.
3. **Environment variable on a single hardened host**. Acceptable for early-stage deployment. Rotate frequently.
4. **Disk-stored, encrypted at rest**. Same risk profile as (3) with worse forensics.

The reference attestor reads `ATTESTOR_PRIVATE_KEY` from env. For HSM-backed signing, replace `signAttestation` in `attestor/src/signer.ts` with a call to your HSM SDK that signs the same digest.

### Rotation

The `AttestorVerifier` has an immutable approved-attestor set. To rotate, deploy a new verifier with both the old and new addresses, then a new factory, then deprecate the old factory. Users who haven't spent down their old twins keep using them until the old key is decommissioned.

Plan rotation around a deliberate transition window:

```
T=0      Deploy new verifier (old + new keys both approved)
T=0+1d   Announce new factory; senders update to new addresses
T=0+30d  Stop signing with old key
T=0+60d  Old verifier formally deprecated; remaining old-twin holders migrate
```

## Monitoring

Track these signals; spike or drop indicates trouble:

| Metric | Healthy range |
|---|---|
| `POST /attest/.../callback` rate | Whatever your user base does |
| Signed-attestation rate | Should equal callback rate ± a small tail of IdP-rejected flows |
| 4xx rate | <5% (mostly bad return_to or stale state tokens) |
| 5xx rate | <0.1% (IdP outages aside) |
| Time-to-signature p99 | <2s (most of it is the IdP token exchange) |
| Process restart count | 0 in a normal week |

Alert on:
- Any signed attestation with `userId == 0`. The provider should never return that; if it does, something is malformed.
- Signature rate exceeding the user-base baseline by >10× (possible compromised-key abuse).
- HMAC-signed state token verification failures spiking (possible state-token forgery attempts).

## Federation pattern

Run multiple attestor instances with different signing keys. Configure `AttestorVerifier` with all of them in its approved set (1-of-N). Each instance:

- Has its own hostname.
- Has its own IdP app (separate `TWITCH_CLIENT_ID`).
- Has its own signing key.
- Operates independently.

This is "operator diversity" — same threat shape as Wormhole guardians. Compromising any one instance compromises everyone (1-of-N), but the operational diversity makes simultaneous compromise harder than single-operator setups. For stronger guarantees, a future N-of-M threshold verifier (see `ROADMAP.md`) would require multiple signatures over the same digest.

## Adopting in production: checklist

- [ ] AttestorVerifier deployed and Basescan-verified, address shared publicly.
- [ ] Attestor signing key generated in HSM or KMS.
- [ ] Signer address added to AttestorVerifier's approved set at deploy time.
- [ ] Attestor service deployed with HTTPS + valid cert.
- [ ] IdP app (Twitch / Google / …) configured with redirect URL pointing at this attestor.
- [ ] `ALLOWED_RETURN_ORIGINS` restricted to known-good dApp origins.
- [ ] `STATE_HMAC_SECRET` is ≥32 bytes of random entropy.
- [ ] Health endpoint monitored with alerting.
- [ ] Signed-attestation rate compared to historical baseline; alert on >10× spikes.
- [ ] Incident response runbook for "attestor key compromised" — see [`KEY_MANAGEMENT.md`](./KEY_MANAGEMENT.md).
