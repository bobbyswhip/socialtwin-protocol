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
///   1. Fresh Twitch JWT (the default; works while Twitch maintains OIDC).
///   2. A connected "escape" EOA (self-custody; survives Twitch shutting us
///      down or rotating their signing key). Once the real Twitch owner
///      connects an EOA via setOwnerEOA(), that EOA can spend forever with
///      no JWT — full custody independent of Twitch.
///
/// Abandoned-funds rescue:
///   If a twin is NEVER activated (the streamer never connected — never
///   executed, never set an EOA) and more than RESCUE_DELAY has elapsed
///   since deployment, the factory's `rescuer` may delegate control to a
///   designated EOA. This recovers community-deposited funds that would
///   otherwise be stuck forever. The rescuer can NEVER touch a twin whose
///   owner has shown up even once, and the role is renounceable.
contract TwinAccount is ReentrancyGuard {
    uint64 public immutable userId;
    IVerifier public immutable verifier;
    address public immutable factory;

    /// @notice Past-freshness bound on the JWT's iat. 5 minutes.
    uint256 public constant MAX_PROOF_AGE = 5 minutes;
    /// @notice Future-skew cap on the JWT's iat. 60 seconds.
    uint256 public constant MAX_CLOCK_SKEW = 60 seconds;
    /// @notice A twin must sit untouched (never activated) this long before
    ///         abandoned-rescue is allowed.
    uint256 public constant RESCUE_DELAY = 90 days; // 3 months

    /// @notice JWT-path replay nonce.
    uint256 public nonce;
    /// @notice Connected self-custody EOA. address(0) until set. When non-zero,
    ///         this EOA can spend with no JWT.
    address public ownerEOA;
    /// @notice True once the real owner has demonstrated control (any JWT
    ///         execute, or setOwnerEOA). Permanently disables abandoned-rescue.
    bool public activated;
    /// @notice block.timestamp at deployment — starts the rescue clock.
    uint64 public immutable deployedAt;

    event Executed(uint256 indexed nonce, address indexed target, uint256 value, bytes32 actionHash);
    event BatchExecuted(uint256 indexed nonce, uint256 callCount, bytes32 actionHash);
    event OwnerEOASet(address indexed owner, bool viaRescue);
    event OwnerExecuted(address indexed owner, address indexed target, uint256 value);
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
    error NotRescuer();
    error AlreadyActivated();
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

    /// @notice Connect (or rotate) the self-custody escape EOA. JWT-gated, so
    ///         only the real Twitch owner can call it. After this, `ownerEOA`
    ///         can spend with no JWT — surviving any future Twitch shutdown.
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
        emit OwnerEOASet(newOwner, false);
    }

    function _checkJwt(
        bytes32 actionHash,
        uint256 _nonce,
        uint256 deadline,
        uint256 oauthExchangeEpoch,
        bytes calldata jwt
    ) internal view {
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

    /// @notice Delegate control of a NEVER-ACTIVATED twin to a designated EOA
    ///         after RESCUE_DELAY. Recovers community funds sent to a streamer
    ///         who never connected. Callable only by the factory's current
    ///         rescuer. Can never touch an activated twin.
    function rescueAbandoned(address designatedEOA) external nonReentrant {
        if (designatedEOA == address(0)) revert ZeroAddress();
        address r = ITwinFactoryRescuer(factory).rescuer();
        if (r == address(0) || msg.sender != r) revert NotRescuer();
        if (activated || ownerEOA != address(0)) revert AlreadyActivated();
        uint256 allowedAt = uint256(deployedAt) + RESCUE_DELAY;
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

    function rescueAllowedAt() external view returns (uint256) {
        return uint256(deployedAt) + RESCUE_DELAY;
    }

    function isRescuable() external view returns (bool) {
        return !activated
            && ownerEOA == address(0)
            && block.timestamp >= uint256(deployedAt) + RESCUE_DELAY;
    }
}
