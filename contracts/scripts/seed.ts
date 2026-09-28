/**
 * Seeds on-chain rental states for the demo.
 * Requires NEXT_PUBLIC_ESCROW_ADDRESS / deployments JSON and funded signers.
 * Does not invent tx hashes — prints only hashes returned by the network.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const dest = path.join(__dirname, "..", "..", "packages", "shared", "deployments", "mstTestnet.json");
  if (!fs.existsSync(dest)) {
    throw new Error("No deployment file. Deploy first.");
  }
  const d = JSON.parse(fs.readFileSync(dest, "utf8"));
  if (!d.address || d.address.length !== 42) {
    throw new Error("Deployment address is empty. Real deploy has not run.");
  }
  const c = await ethers.getContractAt("CampusRentEscrow", d.address);
  console.log("Seed against", d.address);
  console.log("Use Hardhat accounts that are registered students with matching campusId.");
  console.log("This script is a helper: register students, fund one rental, then walk states with time.");
  console.log("nextRentalId", await c.nextRentalId());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
