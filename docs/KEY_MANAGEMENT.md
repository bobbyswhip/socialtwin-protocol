# Key management

The single most important secret in the protocol is the attestor's ECDSA private key. This document covers generation, storage, rotation, and incident response.

## Key inventory

| Key | Holder | Impact if leaked | Rotatable? |
|---|---|---|---|
| Attestor signing key (ECDSA) | Operator | Every twin bound to this verifier is drainable | Yes — deploy new verifier + factory |
| State HMAC secret | Operator | Attackers can forge OAuth state tokens (CSRF risk on the OAuth round-trip) | Yes — restart attestor |
| Twitch app client_secret | Operator | Attackers can impersonate the OAuth client (but still need user gesture to drain) | Yes — Twitch dashboard |
| Deployer key | Whoever ran `hardhat run scripts/...` | One-shot risk during deployment only | N/A after deploy |
| Twitch user passwords | End users | Their twin is drainable | User responsibility |

## Generating the attestor signing key

```bash
# Random 32-byte private key (do this in a secure environment)
openssl rand -hex 32

# Derive the public address from the key (which is what goes in the verifier)
node -e "
  const { privateKeyToAddress } = require('viem/accounts');
  console.log(privateKeyToAddress('0x' + process.argv[1]));
" <hex-key>
```

**Do not** generate the key on a development laptop and email it to yourself. Generate inside the production environment (HSM, KMS, ECS task, etc.) and never let it touch disk in plaintext.

## Storage options

### Tier 1 — HSM (recommended for production)

AWS CloudHSM, GCP Cloud KMS with hardware backing, Azure Key Vault HSM. The key never leaves the appliance:

```
attestor service
       │ "sign this 32-byte digest"
       ▼
   HSM endpoint
       │ ecdsa_sign(privkey, digest) → signature
       ▼
attestor service
       │ "here's the signature"
       ▼
   user / contract
```

Replace `attestor/src/signer.ts::signAttestation` with a wrapper around your HSM's SDK. Implementations:
- AWS KMS: `@aws-sdk/client-kms` with `Sign` operation, `SigningAlgorithm: "ECDSA_SHA_256"`. Note: KMS signs raw digests so you must apply EIP-191 prefix yourself, then have KMS sign the keccak256 of that.
- GCP KMS: similar via `@google-cloud/kms`.

### Tier 2 — TEE (Nitro Enclave / SGX)

The key is sealed to the enclave; only attested code can decrypt it. Open-source examples:
- `aws-nitro-enclaves-sdk-js`
- Phala Network's `phat-contract` SDK

### Tier 3 — single hardened VM with env var

OK for early-stage. Treat the host like a CA:
- Dedicated VM, no other services.
- No SSH; only access via secure session manager (AWS SSM, GCP IAP).
- Disk encryption.
- Outbound network restricted to IdP endpoints + Base RPC.
- Logs do not echo the key (verified before deploy).

### Tier 0 (not acceptable)

- Storing in source control.
- Storing in client-side env vars (visible to browser).
- Storing in cleartext config files committed to backups.

## Rotation procedure

The `AttestorVerifier` is immutable. Rotation requires deploying a new verifier (and new factory) and migrating users.

### Planned rotation (e.g., annual)

```
Day 0:   Generate new key K' (Tier 1 or 2 above).
Day 0:   Deploy AttestorVerifier' with both K (old address) and K' (new address) in the approved set.
Day 0:   Deploy TwinFactory' pointing at AttestorVerifier'.
Day 0:   Update attestor service config: ATTESTOR_PRIVATE_KEY=K', VERIFIER_ADDRESS=AttestorVerifier', publish new TwinFactory'.
Day 1+:  Senders publish updated factory address; new sends go to twins in TwinFactory'.
Day 0–30: Users with funds in old twins (TwinFactory) migrate by withdrawing to their wallet, then re-receiving into the new factory's twin address.
Day 31+: Old key K is decommissioned (zero out from HSM).
Day 60+: Old AttestorVerifier and TwinFactory are formally deprecated. Remaining unspent funds in old twins are stuck — users must use a wallet that still recognizes the old verifier.
```

The new factory will derive different twin addresses (CREATE2 input changed), so old and new are not interchangeable. This is intentional: it gives an unambiguous bright line between key generations.

### Emergency rotation (key compromise suspected)

```
Hour 0:  Suspect signal observed (signature rate anomaly, alert from monitoring).
Hour 0:  Take attestor service offline immediately to prevent further signing.
Hour 0:  Notify users to STOP DEPOSITING. Post to Twitter, project Discord, etc.
Hour 1:  Confirm compromise via audit logs (HSM access logs, network egress, suspicious signatures onchain).
Hour 2:  Generate new key in fresh HSM slot.
Hour 4:  Deploy new AttestorVerifier with ONLY the new key (omit the compromised one).
Hour 4:  Deploy new TwinFactory pointing at the new verifier.
Hour 5:  Bring attestor service back online with new config.
Hour 5+: Announce: "Old factory deprecated; do not deposit. Twins on old factory may have been drained; we are working to identify affected users."
Day 1+:  Forensic analysis of which twins were drained; reach out to affected users.
```

The protocol can't recover funds that were drained. Speed of detection is the variable that matters most. Hence the monitoring section in [`ATTESTOR_OPERATIONS.md`](./ATTESTOR_OPERATIONS.md).

## Reducing blast radius

Two architectural choices reduce the impact of a single key compromise:

1. **1-of-N federation.** Run multiple attestors with separate keys. Compromise of one doesn't compromise the others — but ANY one of them can sign, so this is operator diversity not threshold security. Useful for redundancy + monitoring (a malicious-key signature would be visible to peers).
2. **N-of-M threshold (future).** Requires multiple signatures over the same digest. Compromise of one key is insufficient to drain. Implementation deferred to a future verifier; see [`FEDERATION.md`](./FEDERATION.md).

## A note on auditability

The attestor signs over a public digest derived from public inputs. Anyone can:
- Watch the chain for `Executed` events.
- Recover the signer from the onchain proof.
- Verify it's in the approved-attestor set.
- Cross-reference against the attestor's own claim of having signed it.

If the attestor's signature rate diverges from `Executed` events for known userIds, something is wrong. This is the protocol's primary anomaly-detection signal.
