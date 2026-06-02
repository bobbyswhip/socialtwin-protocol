// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IVerifier} from "./interfaces/IVerifier.sol";

/// @title SocialTwinEscrow
/// @notice Permissionless escrow that lets anyone deposit value earmarked for a
///         Twitter user_id, and lets that user (proven by a ZK-TLS proof of an
///         authenticated Twitter session) claim it into a destination address
///         of their choice. No persistent per-user state, no account ownership,
///         no admin, no upgrade path.
contract SocialTwinEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IVerifier public immutable verifier;
    /// @notice Maximum age, in seconds, of the OAuth code exchange the proof
    ///         attests to. Twitter codes are valid for ~30s, so 5 minutes is a
    ///         generous upper bound that still forces the OAuth to be FRESH —
    ///         meaning the user clicked "Authorize" on twitter.com within the
    ///         last few minutes. This is the load-bearing constant that
    ///         prevents stolen-token replay.
    uint256 public constant MAX_PROOF_AGE = 5 minutes;
    uint256 public constant MIN_REFUND_DELAY = 1 days;

    enum Status { ACTIVE, CLAIMED, REFUNDED }

    struct Deposit {
        uint64 userId;        // Twitter numeric user_id (immutable identifier)
        address sender;       // who deposited; only this address can refund
        address token;        // address(0) = native ETH
        uint256 amount;
        uint64 depositedAt;
        uint64 expiry;        // 0 = no expiry, no refund ever
        Status status;
    }

    uint256 public depositCount;
    mapping(uint256 => Deposit) public deposits;

    constructor(IVerifier _verifier) {
        verifier = _verifier;
    }

    event Deposited(
        uint256 indexed depositId,
        uint64 indexed userId,
        address indexed sender,
        address token,
        uint256 amount,
        uint64 expiry
    );
    event Claimed(uint256 indexed depositId, uint64 indexed userId, address indexed destination);
    event Refunded(uint256 indexed depositId, address indexed sender);

    error ZeroAmount();
    error ExpiryTooSoon(uint64 expiry, uint64 floor);
    error InvalidProof();
    error DepositNotActive(uint256 depositId);
    error UserIdMismatch(uint256 depositId);
    error AlreadyExpired(uint256 depositId);
    error NotYetExpired(uint256 depositId);
    error NotSender(uint256 depositId);
    error DeadlinePassed();
    error ProofTooOld();
    error TransferFailed();

    // -------------------- DEPOSIT --------------------

    function depositETH(uint64 userId, uint64 expiry) external payable returns (uint256 depositId) {
        if (msg.value == 0) revert ZeroAmount();
        _validateExpiry(expiry);
        depositId = _record(userId, address(0), msg.value, expiry);
    }

    function depositERC20(
        uint64 userId,
        address token,
        uint256 amount,
        uint64 expiry
    ) external returns (uint256 depositId) {
        if (amount == 0) revert ZeroAmount();
        _validateExpiry(expiry);
        // Pull tokens; trust msg.sender to have approved this contract.
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balanceBefore;
        // Handle fee-on-transfer tokens: record what was actually received.
        depositId = _record(userId, token, received, expiry);
    }

    function _record(
        uint64 userId,
        address token,
        uint256 amount,
        uint64 expiry
    ) internal returns (uint256 depositId) {
        depositId = ++depositCount;
        deposits[depositId] = Deposit({
            userId: userId,
            sender: msg.sender,
            token: token,
            amount: amount,
            depositedAt: uint64(block.timestamp),
            expiry: expiry,
            status: Status.ACTIVE
        });
        emit Deposited(depositId, userId, msg.sender, token, amount, expiry);
    }

    function _validateExpiry(uint64 expiry) internal view {
        if (expiry == 0) return; // 0 = permanent, no refund ever
        uint64 floor = uint64(block.timestamp + MIN_REFUND_DELAY);
        if (expiry < floor) revert ExpiryTooSoon(expiry, floor);
    }

    // -------------------- CLAIM --------------------

    /// @notice Claim a batch of deposits earmarked for `userId` into msg.sender.
    /// @dev `msg.sender` IS the destination. The ZK proof commits to msg.sender
    ///      so a relayer cannot redirect the claim. The proof MUST attest to a
    ///      FRESH OAuth code exchange — see IVerifier NatSpec — which is what
    ///      blocks bearer-token replay by malicious apps holding stale tokens.
    function claim(
        uint256[] calldata depositIds,
        uint64 userId,
        uint64 deadline,
        uint64 oauthExchangeEpoch,
        bytes calldata zkProof
    ) external nonReentrant {
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (block.timestamp > uint256(oauthExchangeEpoch) + MAX_PROOF_AGE) revert ProofTooOld();

        bytes32 actionHash = computeClaimHash(depositIds, userId, msg.sender, deadline);
        if (!verifier.verify(userId, actionHash, oauthExchangeEpoch, zkProof)) revert InvalidProof();

        uint256 totalETH;
        for (uint256 i = 0; i < depositIds.length; i++) {
            uint256 id = depositIds[i];
            Deposit storage d = deposits[id];
            if (d.status != Status.ACTIVE) revert DepositNotActive(id);
            if (d.userId != userId) revert UserIdMismatch(id);
            if (d.expiry != 0 && block.timestamp >= d.expiry) revert AlreadyExpired(id);

            d.status = Status.CLAIMED;
            emit Claimed(id, userId, msg.sender);

            if (d.token == address(0)) {
                totalETH += d.amount;
            } else {
                IERC20(d.token).safeTransfer(msg.sender, d.amount);
            }
        }

        if (totalETH > 0) {
            (bool ok, ) = msg.sender.call{value: totalETH}("");
            if (!ok) revert TransferFailed();
        }
    }

    function computeClaimHash(
        uint256[] calldata depositIds,
        uint64 userId,
        address destination,
        uint64 deadline
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                "SocialTwinEscrow:v1:claim",
                block.chainid,
                address(this),
                userId,
                destination,
                keccak256(abi.encodePacked(depositIds)),
                deadline
            )
        );
    }

    // -------------------- REFUND --------------------

    function refund(uint256 depositId) external nonReentrant {
        Deposit storage d = deposits[depositId];
        if (d.status != Status.ACTIVE) revert DepositNotActive(depositId);
        if (d.sender != msg.sender) revert NotSender(depositId);
        if (d.expiry == 0) revert NotYetExpired(depositId); // no expiry = no refund
        if (block.timestamp < d.expiry) revert NotYetExpired(depositId);

        d.status = Status.REFUNDED;
        address token = d.token;
        uint256 amount = d.amount;
        address sender = d.sender;
        emit Refunded(depositId, sender);

        if (token == address(0)) {
            (bool ok, ) = sender.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(token).safeTransfer(sender, amount);
        }
    }

    // -------------------- VIEWS --------------------

    function getDeposit(uint256 depositId) external view returns (Deposit memory) {
        return deposits[depositId];
    }
}
