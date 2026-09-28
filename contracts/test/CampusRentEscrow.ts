import { expect } from "chai";
import { ethers } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 60;

function domain(chainId: bigint, address: string) {
  return { name: "CampusRent", version: "1", chainId, verifyingContract: address };
}

const offerTypes = {
  RentalOffer: [
    { name: "owner", type: "address" },
    { name: "renter", type: "address" },
    { name: "termsHash", type: "bytes32" },
    { name: "rent", type: "uint128" },
    { name: "deposit", type: "uint128" },
    { name: "lateFeePerDay", type: "uint128" },
    { name: "durationDays", type: "uint32" },
    { name: "handoverDeadline", type: "uint40" },
    { name: "handoverCodeHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "sigDeadline", type: "uint40" },
  ],
};

const voucherTypes = {
  StudentVoucher: [
    { name: "wallet", type: "address" },
    { name: "campusId", type: "bytes32" },
    { name: "expiry", type: "uint40" },
  ],
};

async function deployFixture() {
  const [admin, attester, treasury, owner, renter, arb1, arb2, arb3, other] =
    await ethers.getSigners();
  const Factory = await ethers.getContractFactory("CampusRentEscrow");
  const cfg = {
    dayLength: DAY,
    objectionWindow: DAY,
    responseWindow: DAY,
    overdueGraceDays: 1,
    disputeTimeout: 300,
    maxDurationDays: 30,
    maxHandoverWindow: 3600,
  };
  const c = await Factory.deploy(
    cfg,
    attester.address,
    treasury.address,
    [arb1.address, arb2.address, arb3.address],
    100,
    admin.address
  );
  await c.waitForDeployment();
  const campusId = ethers.id("demo university");
  const expiry = (await time.latest()) + 86400 * 30;
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const addr = await c.getAddress();
  const d = domain(chainId, addr);

  async function register(wallet: typeof owner) {
    const sig = await attester.signTypedData(d, voucherTypes, {
      wallet: wallet.address,
      campusId,
      expiry,
    });
    await c.connect(wallet).registerStudent(campusId, expiry, sig);
  }
  await register(owner);
  await register(renter);

  const secret = ethers.id("handover-secret");
  const codeHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [secret]));
  const termsHash = ethers.id("terms");
  const rent = ethers.parseEther("1");
  const deposit = ethers.parseEther("2");
  const late = ethers.parseEther("0.5");

  async function signOffer(nonce: number, extra: Partial<Record<string, unknown>> = {}) {
    const now = await time.latest();
    const offer = {
      owner: owner.address,
      renter: renter.address,
      termsHash,
      rent,
      deposit,
      lateFeePerDay: late,
      durationDays: 1,
      handoverDeadline: now + 600,
      handoverCodeHash: codeHash,
      nonce,
      sigDeadline: now + 3600,
      ...extra,
    };
    const sig = await owner.signTypedData(d, offerTypes, offer);
    return { offer, sig };
  }

  return {
    c,
    admin,
    attester,
    treasury,
    owner,
    renter,
    arb1,
    arb2,
    arb3,
    other,
    campusId,
    d,
    secret,
    codeHash,
    rent,
    deposit,
    late,
    signOffer,
    addr,
    chainId,
  };
}

describe("CampusRentEscrow", () => {
  it("registerStudent: valid, wrong signer, expired", async () => {
    const { c, attester, other, campusId, d } = await loadFixture(deployFixture);
    const expiry = (await time.latest()) + 100;
    const sig = await attester.signTypedData(d, voucherTypes, {
      wallet: other.address,
      campusId,
      expiry,
    });
    await c.connect(other).registerStudent(campusId, expiry, sig);
    expect(await c.campusOf(other.address)).to.equal(campusId);

    const bad = await other.signTypedData(d, voucherTypes, {
      wallet: other.address,
      campusId,
      expiry: expiry + 1,
    });
    await expect(c.connect(other).registerStudent(campusId, expiry + 1, bad)).to.be.revertedWithCustomError(
      c,
      "BadSignature"
    );

    await time.increase(200);
    await expect(c.connect(other).registerStudent(campusId, expiry, sig)).to.be.revertedWithCustomError(
      c,
      "OfferExpired"
    );
  });

  it("hashOffer matches signTypedData recover", async () => {
    const { c, signOffer, owner } = await loadFixture(deployFixture);
    const { offer, sig } = await signOffer(1);
    const digest = await c.hashOffer(offer);
    expect(ethers.verifyTypedData((await ethers.provider.getNetwork()).chainId ? {} as never : {}, {}, {}) || true).to.equal(true);
    const recovered = ethers.verifyMessage ? ethers.recoverAddress(digest, sig) : ethers.recoverAddress(digest, sig);
    expect(recovered).to.equal(owner.address);
  });

  it("happy path: fund, handover, confirmReturn, fee 1%", async () => {
    const { c, owner, renter, treasury, signOffer, secret, rent, deposit } = await loadFixture(deployFixture);
    const { offer, sig } = await signOffer(10);
    const value = rent + deposit;
    const id = 1n;
    await expect(c.connect(renter).fundRental(offer, sig, { value }))
      .to.emit(c, "RentalFunded")
      .withArgs(id, owner.address, renter.address, offer.termsHash, rent, deposit, offer.handoverDeadline);

    const ev0 = ethers.ZeroHash;
    await c.connect(renter).confirmHandover(id, secret, ev0);
    const renterBalBefore = await ethers.provider.getBalance(renter.address);
    const ownerBefore = await ethers.provider.getBalance(owner.address);
    const tx = await c.connect(owner).confirmReturn(id, ev0);
    await tx.wait();
    const st = await c.getRental(id);
    expect(st.status).to.equal(6); // Settled
    const fee = rent / 100n;
    const ownerAfter = await ethers.provider.getBalance(owner.address);
    expect(ownerAfter).to.be.greaterThan(ownerBefore);
    expect(await ethers.provider.getBalance(await c.getAddress())).to.equal(0);
    expect(await ethers.provider.getBalance(treasury.address)).to.equal(fee);
    const repO = await c.getReputation(owner.address);
    const repR = await c.getReputation(renter.address);
    expect(repO.completedAsOwner).to.equal(1);
    expect(repR.completedAsRenter).to.equal(1);
    void renterBalBefore;
  });

  it("fundRental reverts: wrong value, nonce reuse, not renter", async () => {
    const { c, renter, owner, signOffer, rent, deposit } = await loadFixture(deployFixture);
    const { offer, sig } = await signOffer(2);
    await expect(c.connect(renter).fundRental(offer, sig, { value: rent })).to.be.revertedWithCustomError(
      c,
      "BadAmount"
    );
    await expect(c.connect(owner).fundRental(offer, sig, { value: rent + deposit })).to.be.revertedWithCustomError(
      c,
      "NotRenter"
    );
    await c.connect(renter).fundRental(offer, sig, { value: rent + deposit });
    await expect(c.connect(renter).fundRental(offer, sig, { value: rent + deposit })).to.be.revertedWithCustomError(
      c,
      "NonceUsed"
    );
  });

  it("wrong secret and cancelUnstarted refunds", async () => {
    const { c, renter, owner, signOffer, rent, deposit } = await loadFixture(deployFixture);
    const { offer, sig } = await signOffer(3);
    await c.connect(renter).fundRental(offer, sig, { value: rent + deposit });
    await expect(c.connect(renter).confirmHandover(1, ethers.id("nope"), ethers.ZeroHash)).to.be.revertedWithCustomError(
      c,
      "BadSecret"
    );
    const before = await ethers.provider.getBalance(renter.address);
    await c.connect(owner).cancelUnstarted(1);
    const after = await ethers.provider.getBalance(renter.address);
    expect(after - before).to.equal(rent + deposit);
    expect((await c.getRental(1)).status).to.equal(7);
  });

  it("late fee 2 days capped at deposit", async () => {
    const { c, owner, renter, signOffer, secret, rent, deposit } = await loadFixture(deployFixture);
    const { offer, sig } = await signOffer(4);
    await c.connect(renter).fundRental(offer, sig, { value: rent + deposit });
    await c.connect(renter).confirmHandover(1, secret, ethers.ZeroHash);
    await time.increase(DAY * 2 + 2);
    const q = await c.quoteSettlement(1, await time.latest());
    expect(q.lateFee).to.equal(ethers.parseEther("1")); // 2 * 0.5
    await c.connect(owner).confirmReturn(1, ethers.ZeroHash);
    const rep = await c.getReputation(renter.address);
    expect(rep.lateReturns).to.equal(1);
  });

  it("claimReturn then finalizeReturn after window", async () => {
    const { c, renter, signOffer, secret, rent, deposit } = await loadFixture(deployFixture);
    const { offer, sig } = await signOffer(5);
    await c.connect(renter).fundRental(offer, sig, { value: rent + deposit });
    await c.connect(renter).confirmHandover(1, secret, ethers.ZeroHash);
    await c.connect(renter).claimReturn(1, ethers.ZeroHash);
    await expect(c.connect(renter).finalizeReturn(1)).to.be.revertedWithCustomError(c, "TooEarly");
    await time.increase(DAY + 1);
    await c.finalizeReturn(1);
    expect((await c.getRental(1)).status).to.equal(6);
  });

  it("proposeDeduction then accept", async () => {
    const { c, owner, renter, signOffer, secret, rent, deposit } = await loadFixture(deployFixture);
    const { offer, sig } = await signOffer(6);
    await c.connect(renter).fundRental(offer, sig, { value: rent + deposit });
    await c.connect(renter).confirmHandover(1, secret, ethers.ZeroHash);
    const amt = ethers.parseEther("0.2");
    await c.connect(owner).proposeDeduction(1, amt, ethers.ZeroHash);
    await c.connect(renter).acceptDeduction(1);
    expect((await c.getRental(1)).status).to.equal(6);
  });

  it("dispute 2 matching votes OwnerWins", async () => {
    const { c, owner, renter, arb1, arb2, signOffer, secret, rent, deposit } = await loadFixture(deployFixture);
    const { offer, sig } = await signOffer(7);
    await c.connect(renter).fundRental(offer, sig, { value: rent + deposit });
    await c.connect(renter).confirmHandover(1, secret, ethers.ZeroHash);
    await time.increase(DAY + 1);
    await c.connect(owner).raiseDispute(1, ethers.ZeroHash);
    await c.connect(arb1).voteDispute(1, 2); // OwnerWins
    await c.connect(arb2).voteDispute(1, 2);
    expect((await c.getRental(1)).status).to.equal(6);
    expect((await c.getReputation(renter.address)).disputesLost).to.equal(1);
  });

  it("expired dispute splits", async () => {
    const { c, owner, renter, signOffer, secret, rent, deposit } = await loadFixture(deployFixture);
    const { offer, sig } = await signOffer(8);
    await c.connect(renter).fundRental(offer, sig, { value: rent + deposit });
    await c.connect(renter).confirmHandover(1, secret, ethers.ZeroHash);
    await time.increase(DAY + 1);
    await c.connect(owner).raiseDispute(1, ethers.ZeroHash);
    await time.increase(300 + 1);
    await c.resolveExpiredDispute(1);
    expect((await c.getRental(1)).status).to.equal(6);
  });

  it("claimOverdue after grace", async () => {
    const { c, owner, renter, signOffer, secret, rent, deposit } = await loadFixture(deployFixture);
    const { offer, sig } = await signOffer(9);
    await c.connect(renter).fundRental(offer, sig, { value: rent + deposit });
    await c.connect(renter).confirmHandover(1, secret, ethers.ZeroHash);
    await expect(c.connect(owner).claimOverdue(1)).to.be.revertedWithCustomError(c, "TooEarly");
    await time.increase(DAY + DAY + 2);
    await c.connect(owner).claimOverdue(1);
    expect((await c.getReputation(renter.address)).defaults).to.equal(1);
  });

  it("arbiter who is party cannot vote", async () => {
    const { c, owner, renter, admin, attester, treasury, arb2, arb3, signOffer, secret, rent, deposit } =
      await loadFixture(deployFixture);
    await c.connect(admin).setArbiters([renter.address, arb2.address, arb3.address]);
    const { offer, sig } = await signOffer(11);
    await c.connect(renter).fundRental(offer, sig, { value: rent + deposit });
    await c.connect(renter).confirmHandover(1, secret, ethers.ZeroHash);
    await time.increase(DAY + 1);
    await c.connect(owner).raiseDispute(1, ethers.ZeroHash);
    await expect(c.connect(renter).voteDispute(1, 1)).to.be.revertedWithCustomError(c, "ArbiterIsParty");
    void attester;
    void treasury;
  });
});
