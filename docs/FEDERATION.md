# Federation

The `AttestorVerifier` supports multiple attestor keys in its immutable approved set. This document covers when and how to use that.

## 1-of-N (today)

The deployed `AttestorVerifier` does 1-of-N: ANY one valid signature from ANY approved attestor passes. The set is fixed at deploy time.

```solidity
new AttestorVerifier([
    0xATTESTOR_A, // operator A (e.g., the protocol's main service)
    0xATTESTOR_B, // operator B (a community-run service)
    0xATTESTOR_C, // operator C (an enterprise partner)
]);
```

### Use cases

- **Liveness.** If A's service is down, users can route to B's or C's. The contract doesn't care which one signs.
- **Operational diversity.** Different teams, different infrastructure, different geographies. Reduces the chance of simultaneous outage.
- **Backup signers.** A primary attestor with cold-storage backups that can take over in emergencies.

### Limitations

1-of-N does NOT reduce the impact of a key compromise. ANY compromised attestor can drain everyone. If you need that property, see "N-of-M threshold" below.

### Operating a 1-of-N federation

Each attestor instance runs independently:
- Its own hostname (e.g., `attestor-a.example.com`).
- Its own IdP app (separate `TWITCH_CLIENT_ID` per attestor).
- Its own signing key.
- Its own monitoring.

dApps can let the user choose:

```ts
const ATTESTORS = [
  { name: "Primary",  origin: "https://attestor-a.example.com" },
  { name: "Backup",   origin: "https://attestor-b.example.com" },
  { name: "Community", origin: "https://attestor-c.example.com" },
];
```

Or just hardcode one default and fall back to others on error.

## N-of-M threshold (future)

For stronger compromise resistance, a future verifier could require `N` signatures over the same digest, drawn from a fixed set of `M` attestors. A single compromise wouldn't be enough — the attacker would need `N` simultaneous compromises.

This is the Wormhole guardian / LayerZero DVN model. It's not implemented in the reference repo yet; the design is straightforward:

```solidity
function verify(
    uint64 userId,
    bytes32 actionHash,
    uint256 epoch,
    bytes calldata proof  // packed N signatures
) external view returns (bool) {
    bytes32 digest = ...;
    require(proof.length == 65 * THRESHOLD, "bad sig count");
    address[] memory seen = new address[](THRESHOLD);
    for (uint i = 0; i < THRESHOLD; i++) {
        bytes calldata sig = proof[i*65:(i+1)*65];
        address recovered = digest.toEthSignedMessageHash().recover(sig);
        require(isApproved[recovered], "unapproved");
        for (uint j = 0; j < i; j++) require(seen[j] != recovered, "duplicate");
        seen[i] = recovered;
    }
    return true;
}
```

### Use cases

- **High-value deployments.** When the funds at risk exceed what 1-of-N can comfortably defend.
- **Public trust requirements.** Demonstrably-decentralized verification suitable for institutional adoption.

### Tradeoffs

- Higher gas (multiple ecrecover calls).
- More operational coordination — every action requires N attestors to sign within MAX_PROOF_AGE.
- Bigger off-chain orchestration layer (aggregator service that fans out to attestors and collects signatures).

### When to use it

Not until production traffic on 1-of-N justifies the operational complexity. The reference repo includes 1-of-N as the production-ready primitive; N-of-M is on the roadmap as a future-deploy variant.

## Other federation models we considered

### Per-user attestor allowlists
Each user picks which attestors they trust at twin-creation time. Strictly more flexible but adds significant on-chain state and per-user setup friction. Rejected for v1 because the global approved set is simpler to reason about.

### Slashing
The attestor stakes ETH; if they sign maliciously, the stake gets slashed. Requires a mechanism to prove "this signature was malicious," which is the hard part (the protocol can't distinguish "attestor signed something the user didn't want" from "attestor signed something the user did want"). Rejected as not currently solvable without external evidence.

### Reputation-weighted
Attestors with longer history or larger volume get more weight in some scoring. Off-chain reputation systems are out of scope; the protocol can only know what's on-chain.

## Recommendation

Start with 1-of-N (1-of-1 or 1-of-3 in practice). Monitor for incidents. Move to N-of-M only when the operational maturity is there and the protocol value at risk warrants the complexity. Don't ship N-of-M until at least 6 months of single-attestor operation has surfaced (or failed to surface) any issues.
