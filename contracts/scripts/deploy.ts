import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/** Demo config from contract spec §12 */
export const DEMO_CONFIG = {
  dayLength: 60,
  objectionWindow: 60,
  responseWindow: 60,
  overdueGraceDays: 1,
  disputeTimeout: 300,
  maxDurationDays: 30,
  maxHandoverWindow: 3600,
};

async function main() {
  const [deployer] = await ethers.getSigners();
  const attester = process.env.ATTESTER_ADDRESS || deployer.address;
  const treasury = process.env.TREASURY_ADDRESS || deployer.address;
  const a1 = process.env.ARBITER1 || deployer.address;
  const a2 = process.env.ARBITER2;
  const a3 = process.env.ARBITER3;
  if (!a2 || !a3) {
    throw new Error(
      "Set ARBITER1, ARBITER2, ARBITER3 (three distinct addresses) plus optional ATTESTER_ADDRESS / TREASURY_ADDRESS"
    );
  }

  const Factory = await ethers.getContractFactory("CampusRentEscrow");
  const c = await Factory.deploy(
    DEMO_CONFIG,
    attester,
    treasury,
    [a1, a2, a3],
    100,
    deployer.address
  );
  await c.waitForDeployment();
  const address = await c.getAddress();
  const deployTx = c.deploymentTransaction();
  const receipt = deployTx ? await deployTx.wait() : null;
  const deployBlock = receipt?.blockNumber ?? 0;
  const artifact = await ethers.getContractFactory("CampusRentEscrow");
  const abi = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "artifacts", "contracts", "CampusRentEscrow.sol", "CampusRentEscrow.json"),
      "utf8"
    )
  ).abi;

  const out = {
    address,
    deployBlock,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    abi,
    config: DEMO_CONFIG,
    attester,
    treasury,
    arbiters: [a1, a2, a3],
    deployer: deployer.address,
    deployTxHash: deployTx?.hash ?? null,
  };

  const dest = path.join(__dirname, "..", "..", "packages", "shared", "deployments", "mstTestnet.json");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  console.log("Deployed CampusRentEscrow at", address);
  console.log("Wrote", dest);
  if (out.deployTxHash) console.log("deploy tx", out.deployTxHash);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
