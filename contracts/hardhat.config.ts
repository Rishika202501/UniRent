import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-verify";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "..", ".env") });
dotenv.config({ path: path.join(__dirname, ".env") });

const rpc = process.env.MST_RPC_URL || "";
const chainId = process.env.MST_CHAIN_ID ? Number(process.env.MST_CHAIN_ID) : undefined;
const pk = process.env.DEPLOYER_PRIVATE_KEY;

const networks: HardhatUserConfig["networks"] = {
  hardhat: { chainId: 31337 },
};

if (rpc && chainId && pk && /^0x[0-9a-fA-F]{64}$/.test(pk)) {
  networks.mstTestnet = {
    url: rpc,
    chainId,
    accounts: [pk],
  };
}

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: { evmVersion: "cancun", optimizer: { enabled: true, runs: 200 } },
  },
  networks,
  etherscan: {
    apiKey: { mstTestnet: "no-key" },
    customChains: chainId
      ? [
          {
            network: "mstTestnet",
            chainId,
            urls: {
              apiURL: "https://testnet.mstscan.com/api",
              browserURL: "https://testnet.mstscan.com",
            },
          },
        ]
      : [],
  },
};

export default config;
