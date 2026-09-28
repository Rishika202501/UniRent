# CampusRent

Student-to-student rentals on campus. The MST smart contract holds rent and deposit; listings, photos, and chat stay off-chain.

**Chain:** MST Blockchain Testnet  
**Track fit:** Programmable Commerce (escrow / rent-use-return) + Identity & Reputation

## MST integration (verified)

| Item | Value | Source |
|---|---|---|
| Network | MST Testnet | [Official docs](https://docs.mstblockchain.com/developer-docs/foundation/development-networks-mst-testnet.md) |
| RPC | `https://testnetrpc.mstblockchain.com` | Official docs + live `eth_chainId` |
| Chain ID | `91562037` (`0x5752035`) | Official docs; RPC returned `0x5752035` |
| Explorer | https://testnet.mstscan.com | Official docs |
| Currency | tMSTC | Official docs |
| Contract | *not deployed yet — see `packages/shared/deployments/` after deploy* | — |

Do not treat empty contract addresses or missing tx hashes as real. They are filled only after `hardhat run scripts/deploy.ts --network mstTestnet`.

## Repo

```
contracts/     CampusRentEscrow (Hardhat)
apps/web       Next.js UI + /api
apps/worker    Event indexer
packages/shared  Canonical JSON, EIP-712 types, ABI/address
supabase/      Schema + seed
```

## Setup

1. Copy `.env.example` to `.env` and `apps/web/.env.local`. Fill Supabase and keys. Never commit secrets.
2. `npm install`
3. `npm run compile` then `npm run test:contracts`
4. Deploy only when `DEPLOYER_PRIVATE_KEY` is funded on testnet.
5. Apply `supabase/migrations/0001_init.sql` and `supabase/seed.sql`.
6. `npm run dev`

## Demo (invite)

Campus: **Demo University** · invite code **`MSTDEMO`** (no college email).

Judges: join → link wallet → `registerStudent` → browse → request → owner EIP-712 offer → renter `fundRental` → QR handover → deduction or return → reputation. Open a seeded **Disputed** rental for the arbiter console.
