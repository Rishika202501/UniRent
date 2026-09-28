import { existsSync, readFileSync } from "fs";
import { join } from "path";

export type Deployment = {
  address: `0x${string}`;
  deployBlock: number;
  chainId: number;
  abi: unknown[];
  config?: Record<string, unknown>;
};

export function loadDeployment(
  network = "mstTestnet"
): Deployment | null {
  const p = join(__dirname, "..", "deployments", `${network}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as Deployment;
}

/** Browser-safe: Next.js inlines NEXT_PUBLIC_ESCROW_ADDRESS. */
export function escrowAddressFromEnv(): `0x${string}` | null {
  const a = process.env.NEXT_PUBLIC_ESCROW_ADDRESS;
  if (!a || !a.startsWith("0x") || a.length !== 42) return null;
  return a as `0x${string}`;
}
