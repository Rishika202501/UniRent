// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title CampusRentEscrow — campus P2P rental escrow on MST
/// @dev Non-upgradeable. Admin cannot move escrowed funds.
contract CampusRentEscrow is EIP712, ReentrancyGuard, Pausable, Ownable2Step {
    using ECDSA for bytes32;

    enum Status {
        None,
        Funded,
        Active,
        ReturnPending,
        DeductionProposed,
        Disputed,
        Settled,
        Cancelled
    }
    enum Kind {
        Return,
        ClaimedReturn,
        Deduction,
        Dispute,
        Overdue
    }
    enum Outcome {
        None,
        RenterWins,
        OwnerWins,
        Split
    }

    struct Config {
        uint32 dayLength;
        uint32 objectionWindow;
        uint32 responseWindow;
        uint32 overdueGraceDays;
        uint32 disputeTimeout;
        uint32 maxDurationDays;
        uint32 maxHandoverWindow;
    }

    struct Offer {
        address owner;
        address renter;
        bytes32 termsHash;
        uint128 rent;
        uint128 deposit;
        uint128 lateFeePerDay;
        uint32 durationDays;
        uint40 handoverDeadline;
        bytes32 handoverCodeHash;
        uint256 nonce;
        uint40 sigDeadline;
    }

    struct Rental {
        address owner;
        address renter;
        uint128 rent;
        uint128 deposit;
        uint128 lateFeePerDay;
        uint128 proposedDeduction;
        uint32 durationDays;
        uint40 handoverDeadline;
        uint40 startTime;
        uint40 dueTime;
        uint40 returnClaimedAt;
        uint40 stateChangedAt;
        Status status;
        bytes32 termsHash;
        bytes32 handoverCodeHash;
    }

    struct Reputation {
        uint32 completedAsOwner;
        uint32 completedAsRenter;
        uint32 lateReturns;
        uint32 disputesLost;
        uint32 defaults;
        uint32 cancellations;
        uint128 volume;
    }

    bytes32 public constant OFFER_TYPEHASH = keccak256(
        "RentalOffer(address owner,address renter,bytes32 termsHash,uint128 rent,uint128 deposit,uint128 lateFeePerDay,uint32 durationDays,uint40 handoverDeadline,bytes32 handoverCodeHash,uint256 nonce,uint40 sigDeadline)"
    );
    bytes32 public constant VOUCHER_TYPEHASH =
        keccak256("StudentVoucher(address wallet,bytes32 campusId,uint40 expiry)");

    uint32 public immutable dayLength;
    uint32 public immutable objectionWindow;
    uint32 public immutable responseWindow;
    uint32 public immutable overdueGraceDays;
    uint32 public immutable disputeTimeout;
    uint32 public immutable maxDurationDays;
    uint32 public immutable maxHandoverWindow;

    uint256 public nextRentalId = 1;
    mapping(uint256 => Rental) private rentals;
    mapping(address => bytes32) public campusOf;
    mapping(address => mapping(uint256 => bool)) public nonceUsed;
    mapping(address => uint256) public pending;
    mapping(address => Reputation) private reputation;
    mapping(address => bool) public isArbiter;
    mapping(uint256 => mapping(address => Outcome)) public votes;
    mapping(uint256 => uint8[4]) private tally;
    mapping(uint256 => uint8) private voteCount;

    address public attester;
    address public treasury;
    uint16 public feeBps;
    address[3] private _arbiters;

    error NotRenter();
    error NotOwner();
    error NotParty();
    error NotArbiter();
    error ArbiterIsParty();
    error AlreadyVoted();
    error BadStatus(Status got);
    error OfferExpired();
    error NonceUsed();
    error BadSignature();
    error CampusMismatch();
    error NotRegistered();
    error BadAmount();
    error BadDuration();
    error BadDeadline();
    error BadSecret();
    error TooEarly();
    error TooLate();
    error DeductionTooLarge();
    error NotAllowedYet();
    error NothingToWithdraw();
    error InvalidConfig();
    error SameParty();
    error FeeTooHigh();

    event StudentRegistered(address indexed wallet, bytes32 indexed campusId);
    event RentalFunded(
        uint256 indexed id,
        address indexed owner,
        address indexed renter,
        bytes32 termsHash,
        uint128 rent,
        uint128 deposit,
        uint40 handoverDeadline
    );
    event HandoverConfirmed(uint256 indexed id, uint40 startTime, uint40 dueTime, bytes32 evidenceHash);
    event ReturnClaimed(uint256 indexed id, uint40 claimedAt, bytes32 evidenceHash);
    event DeductionProposed(uint256 indexed id, uint128 amount, bytes32 evidenceHash);
    event DisputeRaised(uint256 indexed id, address indexed by, bytes32 evidenceHash);
    event DisputeEvidence(uint256 indexed id, address indexed by, bytes32 evidenceHash);
    event DisputeVoted(uint256 indexed id, address indexed arbiter, Outcome outcome);
    event RentalSettled(
        uint256 indexed id,
        Kind kind,
        uint128 toOwner,
        uint128 toRenter,
        uint128 fee,
        uint128 lateFee,
        uint128 deduction
    );
    event RentalCancelled(uint256 indexed id, address indexed by);
    event Withdrawn(address indexed account, uint256 amount);
    event ReturnConfirmed(uint256 indexed id, bytes32 evidenceHash);

    constructor(
        Config memory cfg,
        address attester_,
        address treasury_,
        address[3] memory arbiters_,
        uint16 feeBps_,
        address initialOwner
    ) EIP712("CampusRent", "1") Ownable(initialOwner) {
        if (cfg.dayLength == 0 || cfg.maxDurationDays == 0 || attester_ == address(0) || treasury_ == address(0)) {
            revert InvalidConfig();
        }
        if (feeBps_ > 500) revert FeeTooHigh();
        dayLength = cfg.dayLength;
        objectionWindow = cfg.objectionWindow;
        responseWindow = cfg.responseWindow;
        overdueGraceDays = cfg.overdueGraceDays;
        disputeTimeout = cfg.disputeTimeout;
        maxDurationDays = cfg.maxDurationDays;
        maxHandoverWindow = cfg.maxHandoverWindow;
        attester = attester_;
        treasury = treasury_;
        feeBps = feeBps_;
        _setArbiters(arbiters_);
    }

    receive() external payable {
        revert();
    }

    fallback() external payable {
        revert();
    }

    function registerStudent(bytes32 campusId, uint40 expiry, bytes calldata sig) external {
        if (block.timestamp > expiry) revert OfferExpired();
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(VOUCHER_TYPEHASH, msg.sender, campusId, expiry))
        );
        address signer = ECDSA.recover(digest, sig);
        if (signer != attester) revert BadSignature();
        campusOf[msg.sender] = campusId;
        emit StudentRegistered(msg.sender, campusId);
    }

    function fundRental(Offer calldata o, bytes calldata ownerSig)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 id)
    {
        if (msg.sender != o.renter) revert NotRenter();
        if (o.owner == o.renter) revert SameParty();
        if (block.timestamp > o.sigDeadline) revert OfferExpired();
        if (nonceUsed[o.owner][o.nonce]) revert NonceUsed();
        address recovered = ECDSA.recover(_hashOffer(o), ownerSig);
        if (recovered != o.owner) revert BadSignature();
        bytes32 camp = campusOf[o.owner];
        if (camp == bytes32(0) || campusOf[o.renter] != camp) revert CampusMismatch();
        if (campusOf[o.renter] == bytes32(0)) revert NotRegistered();
        if (o.rent == 0) revert BadAmount();
        if (o.durationDays < 1 || o.durationDays > maxDurationDays) revert BadDuration();
        if (o.lateFeePerDay > o.deposit) revert BadAmount();
        if (o.handoverDeadline <= block.timestamp || o.handoverDeadline > block.timestamp + maxHandoverWindow) {
            revert BadDeadline();
        }
        if (msg.value != uint256(o.rent) + uint256(o.deposit)) revert BadAmount();

        nonceUsed[o.owner][o.nonce] = true;
        id = nextRentalId++;
        Rental storage r = rentals[id];
        r.owner = o.owner;
        r.renter = o.renter;
        r.rent = o.rent;
        r.deposit = o.deposit;
        r.lateFeePerDay = o.lateFeePerDay;
        r.durationDays = o.durationDays;
        r.handoverDeadline = o.handoverDeadline;
        r.status = Status.Funded;
        r.termsHash = o.termsHash;
        r.handoverCodeHash = o.handoverCodeHash;
        emit RentalFunded(id, o.owner, o.renter, o.termsHash, o.rent, o.deposit, o.handoverDeadline);
    }

    function confirmHandover(uint256 id, bytes32 secret, bytes32 evidenceHash) external nonReentrant {
        Rental storage r = rentals[id];
        if (msg.sender != r.renter) revert NotRenter();
        if (r.status != Status.Funded) revert BadStatus(r.status);
        if (block.timestamp > r.handoverDeadline) revert TooLate();
        if (keccak256(abi.encode(secret)) != r.handoverCodeHash) revert BadSecret();
        r.startTime = uint40(block.timestamp);
        r.dueTime = uint40(block.timestamp + uint256(r.durationDays) * uint256(dayLength));
        r.status = Status.Active;
        r.stateChangedAt = uint40(block.timestamp);
        emit HandoverConfirmed(id, r.startTime, r.dueTime, evidenceHash);
    }

    function cancelUnstarted(uint256 id) external nonReentrant {
        Rental storage r = rentals[id];
        if (r.status != Status.Funded) revert BadStatus(r.status);
        bool party = msg.sender == r.owner || msg.sender == r.renter;
        if (!party && block.timestamp < r.handoverDeadline) revert NotAllowedYet();
        if (party && block.timestamp < r.handoverDeadline) {
            reputation[msg.sender].cancellations++;
        }
        r.status = Status.Cancelled;
        emit RentalCancelled(id, msg.sender);
        _pay(r.renter, uint256(r.rent) + uint256(r.deposit));
    }

    function confirmReturn(uint256 id, bytes32 evidenceHash) external nonReentrant {
        Rental storage r = rentals[id];
        if (msg.sender != r.owner) revert NotOwner();
        if (r.status != Status.Active && r.status != Status.ReturnPending) revert BadStatus(r.status);
        emit ReturnConfirmed(id, evidenceHash);
        uint40 returnTime = r.status == Status.Active ? uint40(block.timestamp) : r.returnClaimedAt;
        _settleNormal(id, r, returnTime, 0, Kind.Return);
    }

    function claimReturn(uint256 id, bytes32 evidenceHash) external nonReentrant {
        Rental storage r = rentals[id];
        if (msg.sender != r.renter) revert NotRenter();
        if (r.status != Status.Active) revert BadStatus(r.status);
        r.returnClaimedAt = uint40(block.timestamp);
        r.stateChangedAt = uint40(block.timestamp);
        r.status = Status.ReturnPending;
        emit ReturnClaimed(id, r.returnClaimedAt, evidenceHash);
    }

    function finalizeReturn(uint256 id) external nonReentrant {
        Rental storage r = rentals[id];
        if (r.status != Status.ReturnPending) revert BadStatus(r.status);
        if (block.timestamp < uint256(r.returnClaimedAt) + objectionWindow) revert TooEarly();
        _settleNormal(id, r, r.returnClaimedAt, 0, Kind.ClaimedReturn);
    }

    function proposeDeduction(uint256 id, uint128 amount, bytes32 evidenceHash) external nonReentrant {
        Rental storage r = rentals[id];
        if (msg.sender != r.owner) revert NotOwner();
        uint40 returnTime;
        if (r.status == Status.Active) {
            returnTime = uint40(block.timestamp);
        } else if (r.status == Status.ReturnPending) {
            if (block.timestamp > uint256(r.returnClaimedAt) + objectionWindow) revert TooLate();
            returnTime = r.returnClaimedAt;
        } else {
            revert BadStatus(r.status);
        }
        if (amount == 0) revert BadAmount();
        uint128 late = _lateFee(r, returnTime);
        if (amount > r.deposit - late) revert DeductionTooLarge();
        r.proposedDeduction = amount;
        r.returnClaimedAt = returnTime;
        r.stateChangedAt = uint40(block.timestamp);
        r.status = Status.DeductionProposed;
        emit DeductionProposed(id, amount, evidenceHash);
    }

    function acceptDeduction(uint256 id) external nonReentrant {
        Rental storage r = rentals[id];
        if (msg.sender != r.renter) revert NotRenter();
        if (r.status != Status.DeductionProposed) revert BadStatus(r.status);
        _settleNormal(id, r, r.returnClaimedAt, r.proposedDeduction, Kind.Deduction);
    }

    function claimOverdue(uint256 id) external nonReentrant {
        Rental storage r = rentals[id];
        if (msg.sender != r.owner) revert NotOwner();
        if (r.status != Status.Active) revert BadStatus(r.status);
        if (block.timestamp <= uint256(r.dueTime) + uint256(overdueGraceDays) * uint256(dayLength)) revert TooEarly();
        uint128 fee = uint128((uint256(r.rent) * feeBps) / 10_000);
        uint128 toOwner = r.rent - fee + r.deposit;
        reputation[r.renter].defaults++;
        reputation[r.owner].completedAsOwner++;
        _finish(id, r, Kind.Overdue, toOwner, 0, fee, 0, r.deposit);
    }

    function raiseDispute(uint256 id, bytes32 evidenceHash) external nonReentrant {
        Rental storage r = rentals[id];
        if (msg.sender != r.owner && msg.sender != r.renter) revert NotParty();
        if (
            r.status != Status.Active && r.status != Status.ReturnPending && r.status != Status.DeductionProposed
        ) revert BadStatus(r.status);
        if (msg.sender == r.renter) {
            // always allowed in those three statuses
        } else {
            if (r.status == Status.Active && block.timestamp <= r.dueTime) revert NotAllowedYet();
            if (r.status == Status.DeductionProposed && block.timestamp < uint256(r.stateChangedAt) + responseWindow) {
                revert NotAllowedYet();
            }
        }
        r.status = Status.Disputed;
        r.stateChangedAt = uint40(block.timestamp);
        emit DisputeRaised(id, msg.sender, evidenceHash);
    }

    function submitDisputeEvidence(uint256 id, bytes32 evidenceHash) external {
        Rental storage r = rentals[id];
        if (msg.sender != r.owner && msg.sender != r.renter) revert NotParty();
        if (r.status != Status.Disputed) revert BadStatus(r.status);
        emit DisputeEvidence(id, msg.sender, evidenceHash);
    }

    function voteDispute(uint256 id, Outcome o) external nonReentrant {
        Rental storage r = rentals[id];
        if (r.status != Status.Disputed) revert BadStatus(r.status);
        if (!isArbiter[msg.sender]) revert NotArbiter();
        if (msg.sender == r.owner || msg.sender == r.renter) revert ArbiterIsParty();
        if (o == Outcome.None) revert BadAmount();
        if (votes[id][msg.sender] != Outcome.None) revert AlreadyVoted();
        votes[id][msg.sender] = o;
        tally[id][uint8(o)] += 1;
        voteCount[id] += 1;
        emit DisputeVoted(id, msg.sender, o);
        if (tally[id][uint8(o)] >= 2) {
            _resolveDispute(id, r, o);
        } else if (voteCount[id] >= 3) {
            _resolveDispute(id, r, Outcome.Split);
        }
    }

    function resolveExpiredDispute(uint256 id) external nonReentrant {
        Rental storage r = rentals[id];
        if (r.status != Status.Disputed) revert BadStatus(r.status);
        if (block.timestamp < uint256(r.stateChangedAt) + disputeTimeout) revert TooEarly();
        _resolveDispute(id, r, Outcome.Split);
    }

    function withdraw() external nonReentrant {
        uint256 amt = pending[msg.sender];
        if (amt == 0) revert NothingToWithdraw();
        pending[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amt}("");
        if (!ok) {
            pending[msg.sender] = amt;
            revert NothingToWithdraw();
        }
        emit Withdrawn(msg.sender, amt);
    }

    function getRental(uint256 id) external view returns (Rental memory) {
        return rentals[id];
    }

    function getReputation(address a) external view returns (Reputation memory) {
        return reputation[a];
    }

    function quoteSettlement(uint256 id, uint40 returnTime)
        external
        view
        returns (uint128 lateFee, uint128 toOwner, uint128 toRenter, uint128 fee)
    {
        Rental storage r = rentals[id];
        lateFee = _lateFee(r, returnTime);
        fee = uint128((uint256(r.rent) * feeBps) / 10_000);
        uint128 deduction = r.status == Status.DeductionProposed ? r.proposedDeduction : 0;
        if (deduction > r.deposit - lateFee) deduction = r.deposit - lateFee;
        toOwner = r.rent - fee + lateFee + deduction;
        toRenter = r.deposit - lateFee - deduction;
    }

    function hashOffer(Offer calldata o) external view returns (bytes32) {
        return _hashOffer(o);
    }

    function arbiters() external view returns (address[3] memory) {
        return _arbiters;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setFeeBps(uint16 bps) external onlyOwner {
        if (bps > 500) revert FeeTooHigh();
        feeBps = bps;
    }

    function setTreasury(address t) external onlyOwner {
        if (t == address(0)) revert InvalidConfig();
        treasury = t;
    }

    function setArbiters(address[3] calldata a) external onlyOwner {
        _setArbiters(a);
    }

    function setAttester(address a) external onlyOwner {
        if (a == address(0)) revert InvalidConfig();
        attester = a;
    }

    function _setArbiters(address[3] memory a) internal {
        if (a[0] == address(0) || a[1] == address(0) || a[2] == address(0)) revert InvalidConfig();
        if (a[0] == a[1] || a[0] == a[2] || a[1] == a[2]) revert InvalidConfig();
        for (uint256 i; i < 3; i++) {
            if (_arbiters[i] != address(0)) isArbiter[_arbiters[i]] = false;
        }
        _arbiters = a;
        for (uint256 i; i < 3; i++) {
            isArbiter[a[i]] = true;
        }
    }

    function _hashOffer(Offer calldata o) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    OFFER_TYPEHASH,
                    o.owner,
                    o.renter,
                    o.termsHash,
                    o.rent,
                    o.deposit,
                    o.lateFeePerDay,
                    o.durationDays,
                    o.handoverDeadline,
                    o.handoverCodeHash,
                    o.nonce,
                    o.sigDeadline
                )
            )
        );
    }

    function _lateDays(Rental storage r, uint40 returnTime) internal view returns (uint256) {
        if (returnTime <= r.dueTime) return 0;
        return (uint256(returnTime - r.dueTime) + dayLength - 1) / dayLength;
    }

    function _lateFee(Rental storage r, uint40 returnTime) internal view returns (uint128) {
        uint256 f = _lateDays(r, returnTime) * uint256(r.lateFeePerDay);
        return f > r.deposit ? r.deposit : uint128(f);
    }

    function _settleNormal(uint256 id, Rental storage r, uint40 returnTime, uint128 deduction, Kind kind) internal {
        uint128 late = _lateFee(r, returnTime);
        uint128 maxDed = r.deposit - late;
        if (deduction > maxDed) deduction = maxDed;
        uint128 fee = uint128((uint256(r.rent) * feeBps) / 10_000);
        uint128 toOwner = r.rent - fee + late + deduction;
        uint128 toRenter = r.deposit - late - deduction;
        if (late > 0) reputation[r.renter].lateReturns++;
        reputation[r.owner].completedAsOwner++;
        reputation[r.renter].completedAsRenter++;
        reputation[r.owner].volume += r.rent;
        reputation[r.renter].volume += r.rent;
        _finish(id, r, kind, toOwner, toRenter, fee, late, deduction);
    }

    function _resolveDispute(uint256 id, Rental storage r, Outcome o) internal {
        uint128 fee = uint128((uint256(r.rent) * feeBps) / 10_000);
        uint128 toOwner;
        uint128 toRenter;
        uint128 deduction;
        if (o == Outcome.RenterWins) {
            toOwner = r.rent - fee;
            toRenter = r.deposit;
            reputation[r.owner].disputesLost++;
        } else if (o == Outcome.OwnerWins) {
            toOwner = r.rent - fee + r.deposit;
            toRenter = 0;
            deduction = r.deposit;
            reputation[r.renter].disputesLost++;
        } else {
            toOwner = r.rent - fee + r.deposit / 2;
            toRenter = r.deposit - r.deposit / 2;
            deduction = r.deposit / 2;
        }
        reputation[r.owner].completedAsOwner++;
        reputation[r.renter].completedAsRenter++;
        _finish(id, r, Kind.Dispute, toOwner, toRenter, fee, 0, deduction);
    }

    function _finish(
        uint256 id,
        Rental storage r,
        Kind kind,
        uint128 toOwner,
        uint128 toRenter,
        uint128 fee,
        uint128 late,
        uint128 deduction
    ) internal {
        r.status = Status.Settled;
        emit RentalSettled(id, kind, toOwner, toRenter, fee, late, deduction);
        _pay(r.owner, toOwner);
        _pay(r.renter, toRenter);
        _pay(treasury, fee);
    }

    function _pay(address to, uint256 amt) internal {
        if (amt == 0) return;
        (bool ok,) = to.call{value: amt}("");
        if (!ok) pending[to] += amt;
    }
}
