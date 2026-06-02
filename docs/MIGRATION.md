# Migration guide

How to move from one deployed instance to another. Covers:

1. Migrating users from the onchain JWT verifier to the attestor verifier.
2. Migrating users to a new factory after a key rotation.
3. Adapting a deployed fork to a new identity provider.

## Migrating from `TwitchJWTVerifier` to `AttestorVerifier`

The two verifiers produce different twin addresses (different verifier address baked into CREATE2 initcode). You can't "upgrade in place"; you migrate by:

1. Deploying a new `TwinFactory` pointing at `AttestorVerifier`.
2. Publishing the new factory address.
3. Helping users withdraw from their old twins and receive into their new twins.

### Coordinated migration playbook

```
T=0      Deploy AttestorVerifier with the new approved-attestor set.
T=0      Deploy a new TwinFactory bound to AttestorVerifier.
T=0      Update the public SDK with both factory addresses; mark the new one
         as preferred.
T=0+1d   Notify users: "Your new twin address is X. Old twin Y still works for
         spending only. Senders, please update to the new address."
T=0+7d   Most senders have updated; new deposits flow to the new factory's twins.
T=0+30d  Users with funds in old twins spend them down. Final reminder.
T=0+60d  Old factory marked as deprecated. Old twins still work (no onchain
         change), but the user-facing UI no longer prompts them.
```

There is no onchain migration. Each twin is independent and immutable. Users physically move funds from old to new.

### Tools for users

A simple "drain my old twin to my new twin" page:

```ts
// User authenticates once
const oldTwin = predictTwinAddress({ factory: OLD_FACTORY, verifier: OLD_VERIFIER, userId });
const newTwin = predictTwinAddress({ factory: NEW_FACTORY, verifier: NEW_VERIFIER, userId });

// Build intent: old twin sends everything to new twin
const intent = {
  twin: oldTwin,
  target: newTwin,
  value: await getBalance(oldTwin),
  data: "0x",
  nonce: await getNonce(oldTwin),
  deadline,
  returnTo: window.location.origin,
};

// Authorize via OLD factory's verifier (the one the old twin uses)
const flow = buildSpendFlow({ ...cfg, verifierAddress: OLD_VERIFIER }, intent);
window.location.href = flow.redirectUrl;
// User completes flow → drain old twin → funds now in new twin.
```

For ERC-20 balances, repeat with each token contract as `target` and the corresponding `transfer(newTwin, balance)` calldata.

## Migrating after an attestor key rotation

Conceptually identical to verifier migration — the new key requires a new verifier (since the approved set is immutable), which requires a new factory.

If you publish the new factory ahead of the rotation date and give users a grace window, most will migrate naturally. Set a hard cutoff:

```
T=0     New AttestorVerifier deployed with both OLD_KEY and NEW_KEY in approved set.
T=0     New TwinFactory deployed (creates new twin addresses).
T=0+30d Old key STOPS signing attestations (attestor service no longer uses it).
T=0+30d Old factory's twins are still spendable IF a user has a valid attestation
        signed by the old key during the overlap window. After the cutoff, they
        can't get fresh attestations for old twins.
T=0+60d Old factory deprecated. Stuck funds revert to "best-effort" recovery —
        users who never spent down their old twin are out of luck.
```

If you want to be especially nice, run a small "rescue attestor" service for some additional period using the OLD_KEY purely to help users drain their old twins. Document this clearly so it's not seen as backdoor.

## Adapting to a different identity provider

Easiest possible case if you don't need address compatibility:

1. Fork the repo.
2. Change the salt domain in `TwinFactory.sol`:
   ```solidity
   string internal constant DOMAIN = "SocialTwin:google:v1";
   ```
3. Add a new provider in `attestor/src/providers/`. See [`ADDING_PROVIDERS.md`](./ADDING_PROVIDERS.md).
4. Deploy fresh factory + verifier.
5. New factory has a different address space (different salt domain) so twin addresses are partitioned from the Twitch deployment.

If you want one factory to support multiple IdPs simultaneously, you'd need to:
- Encode the provider ID into the salt: `salt = keccak256(provider_id || userId)`.
- Have the twin store a `provider` identifier alongside `userId`.
- Have the attestor sign over `(provider, userId, ...)` and the verifier check both.

This is a small fork of the contracts, well within an afternoon's work. Document the choice prominently — adopters who fork your fork need to know.

## Backing up twin state

Twins have a single mutable state value: `nonce`. It's used for replay protection only.

There is no other state to back up. The "wallet" associated with a twin is the user's Twitch account; that's the IdP's responsibility, not yours.

If a user wants to "back up" their twin, the protocol-level answer is: their Twitch account. The forks-of-this-protocol answer might involve a separate registration that allows specifying a recovery address — but that's outside the scope of this reference implementation.

## Disaster recovery: "the attestor lost the key"

This is **catastrophic and irreversible**. The attestor can't sign new attestations, so users can't spend their twins.

Mitigations:
1. **Backup keys** in a separate HSM, behind explicit access controls. Use them only to deploy a replacement attestor.
2. **1-of-N federation** so a single key loss doesn't take down the whole system.
3. **Documented runbook** for "attestor key lost" so the rotation can happen within hours rather than days.

If you have neither backups nor federation: deploy a new factory + attestor, and accept that the old funds are stranded. The protocol can't recover them. This is the cost of operating without external trust roots.
