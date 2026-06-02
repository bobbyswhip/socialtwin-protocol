// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IVerifier} from "./interfaces/IVerifier.sol";

interface ITwinFactoryRescuer {
    function rescuer() external view returns (address);
}

/// @title TwinAccount (v2)
/// @notice Per-Twitch-user smart account at a deterministic Base address.
///
/// Two ways to authorize a spend:
///   1. Fresh Twitch JWT (the bootstrap; works while Twitch maintains OIDC and
///      ONLY until the user takes self-custody — see below).
///   2. A connected "escape" EOA (true self-custody). When the user calls
///      setOwnerEOA(), the twin flips to self-custody PERMANENTLY: the JWT /
///      Twitch path (execute, executeBatch, setOwnerEOA) is disabled forever,
///      and only the owner EOA can spend (executeAsOwner) or hand off
///      (rotateOwnerEOA). This is a one-way handoff — connecting a wallet
///      severs Twitch's power entirely, so a compromised/phished Twitch login
///      can no longer drain or re-point the twin. Trade-off: there is no
///      Twitch-based recovery once self-custodied (use a smart-contract wallet
///      as the owner if you want key recovery). The JWT path is NOT disabled by
///      an abandoned-funds rescue — completeRescue() leaves it open so the real
///      streamer can still reclaim a rescued twin.
///
/// Abandoned-funds rescue (two-phase, intent-based):
///   If a twin is NEVER activated (the streamer never connected — never
///   executed, never set an EOA), the factory's `rescuer` may recover the
///   community-deposited funds in TWO steps:
///     1. initiateRescue()          — signals intent, starts the countdown.
///     2. completeRescue(eoa)        — after RESCUE_DELAY, delegates control.
///   The countdown runs from the rescuer's SIGNAL, not from deployment, so
///   the real owner always gets a full RESCUE_DELAY public window to show up
///   regardless of when the twin was deployed or funded. (Deploy is
///   permissionless, so a deploy-time clock could be started early by anyone;
///   an intent-time clock cannot.) The rescuer can NEVER touch a twin whose
///   owner has shown up even once — any JWT execute or setOwnerEOA activates
///   the twin and permanently blocks rescue.
contract TwinAccount is ReentrancyGuard {
    uint64 public immutable userId;
    IVerifier public immutable verifier;
    address public immutable factory;

    /// @notice Past-freshness bound on the JWT's iat. 5 minutes.
    uint256 public constant MAX_PROOF_AGE = 5 minutes;
    /// @notice Future-skew cap on the JWT's iat. 60 seconds.
    uint256 public constant MAX_CLOCK_SKEW = 60 seconds;
    /// @notice After the rescuer signals intent via initiateRescue(), a
    ///         never-activated twin must sit untouched this long before
    ///         completeRescue() is allowed. Runs from intent, not deploy.
    uint256 public constant RESCUE_DELAY = 90 days; // 3 months

    /// @notice JWT-path replay nonce.
    uint256 public nonce;
    /// @notice Connected self-custody EOA. address(0) until set. When non-zero,
    ///         this EOA can spend with no JWT.
    address public ownerEOA;
    /// @notice True once the real owner has demonstrated control (any JWT
    ///         execute, or setOwnerEOA). Permanently disables abandoned-rescue.
    bool public activated;
    /// @notice True once the user has taken self-custody via setOwnerEOA. While
    ///         true, the JWT/Twitch path is permanently disabled (one-way) — only
    ///         the owner EOA can act. NOT set by completeRescue(), so a rescued
    ///         twin can still be reclaimed by the real streamer via JWT.
    bool public selfCustody;
    /// @notice block.timestamp at deployment. Informational only — the rescue
    ///         clock is NOT based on this (see rescueInitiatedAt).
    uint64 public immutable deployedAt;
    /// @notice block.timestamp when the rescuer called initiateRescue(); 0 until
    ///         then. The RESCUE_DELAY countdown runs from this, not deployedAt.
    uint64 public rescueInitiatedAt;

    event Executed(uint256 indexed nonce, address indexed target, uint256 value, bytes32 actionHash);
    event BatchExecuted(uint256 indexed nonce, uint256 callCount, bytes32 actionHash);
    event OwnerEOASet(address indexed owner, bool viaRescue);
    event OwnerExecuted(address indexed owner, address indexed target, uint256 value);
    event RescueInitiated(address indexed rescuer, uint256 completeAllowedAt);
    event Rescued(address indexed rescuer, address indexed designatedEOA);

    error InvalidProof();
    error WrongNonce(uint256 expected, uint256 got);
    error DeadlinePassed();
    error ProofTooOld();
    error ProofFromFuture();
    error CallFailed(bytes returnData);
    error EmptyBatch();
    error NotOwner();
    error ZeroAddress();
    error SelfCustodyEnabled();
    error NotRescuer();
    error AlreadyActivated();
    error RescueNotInitiated();
    error RescueTooEarly(uint256 allowedAt);

    constructor(uint64 _userId, IVerifier _verifier) {
        userId = _userId;
        verifier = _verifier;
        factory = msg.sender;
        deployedAt = uint64(block.timestamp);
    }

    receive() external payable {}

    // ════════════════════════ JWT PATH ════════════════════════

    function execute(
        address target,
        uint256 value,
        bytes calldata data,
        uint256 _nonce,
        uint256 deadline,
        uint256 oauthExchangeEpoch,
        bytes calldata jwt
    ) external nonReentrant returns (bytes memory) {
        _checkJwt(
            computeActionHash(target, value, data, _nonce, deadline),
            _nonce, deadline, oauthExchangeEpoch, jwt
        );
        unchecked { nonce = _nonce + 1; }
        activated = true;

        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) revert CallFailed(ret);
        emit Executed(_nonce, target, value, computeActionHash(target, value, data, _nonce, deadline));
        return ret;
    }

    function executeBatch(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata datas,
        uint256 _nonce,
        uint256 deadline,
        uint256 oauthExchangeEpoch,
        bytes calldata jwt
    ) external nonReentrant returns (bytes[] memory) {
        if (targets.length == 0) revert EmptyBatch();
        if (targets.length != values.length || values.length != datas.length) revert EmptyBatch();
        _checkJwt(
            computeBatchHash(targets, values, datas, _nonce, deadline),
            _nonce, deadline, oauthExchangeEpoch, jwt
        );
        unchecked { nonce = _nonce + 1; }
        activated = true;

        bytes[] memory rets = new bytes[](targets.length);
        for (uint256 i = 0; i < targets.length; i++) {
            (bool ok, bytes memory ret) = targets[i].call{value: values[i]}(datas[i]);
            if (!ok) revert CallFailed(ret);
            rets[i] = ret;
        }
        emit BatchExecuted(_nonce, targets.length, computeBatchHash(targets, values, datas, _nonce, deadline));
        return rets;
    }

    /// @notice Take self-custody by connecting an owner EOA. JWT-gated, so only
    ///         the real Twitch owner can call it — and only ONCE: it flips
    ///         `selfCustody` on, which PERMANENTLY disables the JWT/Twitch path
    ///         (including this function). Thereafter only `executeAsOwner` /
    ///         `rotateOwnerEOA` (owner-signed) work. A compromised/phished Twitch
    ///         login can no longer touch the twin. To change wallets later, use
    ///         rotateOwnerEOA(), not Twitch.
    function setOwnerEOA(
        address newOwner,
        uint256 _nonce,
        uint256 deadline,
        uint256 oauthExchangeEpoch,
        bytes calldata jwt
    ) external nonReentrant {
        if (newOwner == address(0)) revert ZeroAddress();
        _checkJwt(
            computeSetOwnerHash(newOwner, _nonce, deadline),
            _nonce, deadline, oauthExchangeEpoch, jwt
        );
        unchecked { nonce = _nonce + 1; }
        activated = true;
        ownerEOA = newOwner;
        selfCustody = true; // one-way: the JWT/Twitch path is now permanently disabled
        emit OwnerEOASet(newOwner, false);
    }

    function _checkJwt(
        bytes32 actionHash,
        uint256 _nonce,
        uint256 deadline,
        uint256 oauthExchangeEpoch,
        bytes calldata jwt
    ) internal view {
        // Once the user has taken self-custody, the JWT/Twitch path is dead.
        // Only the owner EOA can act (executeAsOwner / rotateOwnerEOA).
        if (selfCustody) revert SelfCustodyEnabled();
        if (_nonce != nonce) revert WrongNonce(nonce, _nonce);
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (block.timestamp > oauthExchangeEpoch + MAX_PROOF_AGE) revert ProofTooOld();
        if (oauthExchangeEpoch > block.timestamp + MAX_CLOCK_SKEW) revert ProofFromFuture();
        if (!verifier.verify(userId, actionHash, oauthExchangeEpoch, jwt)) revert InvalidProof();
    }

    // ════════════════════ SELF-CUSTODY (EOA) PATH ════════════════════
    // No JWT required. The EOA's own transaction signature is the auth.
    // This path keeps working even if Twitch kills OIDC or rotates keys.

    modifier onlyOwner() {
        if (ownerEOA == address(0) || msg.sender != ownerEOA) revert NotOwner();
        _;
    }

    function executeAsOwner(address target, uint256 value, bytes calldata data)
        external
        nonReentrant
        onlyOwner
        returns (bytes memory)
    {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) revert CallFailed(ret);
        emit OwnerExecuted(msg.sender, target, value);
        return ret;
    }

    function executeBatchAsOwner(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata datas
    ) external nonReentrant onlyOwner returns (bytes[] memory) {
        if (targets.length == 0) revert EmptyBatch();
        if (targets.length != values.length || values.length != datas.length) revert EmptyBatch();
        bytes[] memory rets = new bytes[](targets.length);
        for (uint256 i = 0; i < targets.length; i++) {
            (bool ok, bytes memory ret) = targets[i].call{value: values[i]}(datas[i]);
            if (!ok) revert CallFailed(ret);
            rets[i] = ret;
        }
        return rets;
    }

    /// @notice Rotate the escape EOA without needing Twitch. Only the current
    ///         owner EOA can do this (e.g., to migrate to a new hardware wallet
    ///         after Twitch is gone).
    function rotateOwnerEOA(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        ownerEOA = newOwner;
        emit OwnerEOASet(newOwner, false);
    }

    // ════════════════════ ABANDONED-FUNDS RESCUE ════════════════════

    /// @notice Step 1 — the factory's rescuer signals intent to recover a
    ///         NEVER-ACTIVATED twin, starting a public RESCUE_DELAY countdown.
    ///         The real owner can cancel at any time before completion simply
    ///         by showing up (any JWT execute / setOwnerEOA activates the twin
    ///         and permanently blocks rescue). Re-callable to restart the clock.
    function initiateRescue() external {
        address r = ITwinFactoryRescuer(factory).rescuer();
        if (r == address(0) || msg.sender != r) revert NotRescuer();
        if (activated || ownerEOA != address(0)) revert AlreadyActivated();
        rescueInitiatedAt = uint64(block.timestamp);
        emit RescueInitiated(r, uint256(rescueInitiatedAt) + RESCUE_DELAY);
    }

    /// @notice Step 2 — after RESCUE_DELAY has elapsed since initiateRescue()
    ///         and the twin is STILL never-activated, delegate control to a
    ///         designated EOA. The delay runs from the rescuer's signal, NOT
    ///         from deploy, so the owner always gets a full RESCUE_DELAY window
    ///         regardless of when the twin was deployed or funded. Callable only
    ///         by the factory's current rescuer; can never touch an activated twin.
    function completeRescue(address designatedEOA) external nonReentrant {
        if (designatedEOA == address(0)) revert ZeroAddress();
        address r = ITwinFactoryRescuer(factory).rescuer();
        if (r == address(0) || msg.sender != r) revert NotRescuer();
        if (activated || ownerEOA != address(0)) revert AlreadyActivated();
        if (rescueInitiatedAt == 0) revert RescueNotInitiated();
        uint256 allowedAt = uint256(rescueInitiatedAt) + RESCUE_DELAY;
        if (block.timestamp < allowedAt) revert RescueTooEarly(allowedAt);

        activated = true;
        ownerEOA = designatedEOA;
        emit OwnerEOASet(designatedEOA, true);
        emit Rescued(r, designatedEOA);
    }

    // ════════════════════════ ACTION HASHES ════════════════════════

    function computeActionHash(
        address target,
        uint256 value,
        bytes calldata data,
        uint256 _nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                "TwinAccount:v2:execute",
                block.chainid, address(this), userId,
                target, value, keccak256(data), _nonce, deadline
            )
        );
    }

    function computeBatchHash(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata datas,
        uint256 _nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        bytes32[] memory dataHashes = new bytes32[](datas.length);
        for (uint256 i = 0; i < datas.length; i++) dataHashes[i] = keccak256(datas[i]);
        return keccak256(
            abi.encode(
                "TwinAccount:v2:executeBatch",
                block.chainid, address(this), userId,
                keccak256(abi.encodePacked(targets)),
                keccak256(abi.encodePacked(values)),
                keccak256(abi.encodePacked(dataHashes)),
                _nonce, deadline
            )
        );
    }

    function computeSetOwnerHash(address newOwner, uint256 _nonce, uint256 deadline)
        public view returns (bytes32)
    {
        return keccak256(
            abi.encode(
                "TwinAccount:v2:setOwnerEOA",
                block.chainid, address(this), userId, newOwner, _nonce, deadline
            )
        );
    }

    // ════════════════════════ VIEWS ════════════════════════

    /// @notice Timestamp at which completeRescue() becomes allowed, or 0 if the
    ///         rescuer has not yet called initiateRescue().
    function rescueAllowedAt() external view returns (uint256) {
        if (rescueInitiatedAt == 0) return 0;
        return uint256(rescueInitiatedAt) + RESCUE_DELAY;
    }

    function isRescuable() external view returns (bool) {
        return !activated
            && ownerEOA == address(0)
            && rescueInitiatedAt != 0
            && block.timestamp >= uint256(rescueInitiatedAt) + RESCUE_DELAY;
    }
}
