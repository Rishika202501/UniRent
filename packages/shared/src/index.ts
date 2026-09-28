import { keccak256, toBytes, encodeAbiParameters, stringToBytes } from "viem";

/** Recursive key sort, no whitespace, numbers/bigints as decimal strings. */
export function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    if (typeof v === "bigint") out[k] = v.toString();
    else out[k] = sortKeys(v);
  }
  return out;
}

export const canonical = (o: unknown): string => JSON.stringify(sortKeys(o));

export const keccakUtf8 = (s: string): `0x${string}` => keccak256(toBytes(s));

export type Terms = {
  v: 1;
  listingId: string;
  title: string;
  category: string;
  condition: string;
  imageSha256s: string[];
  rentWei: string;
  depositWei: string;
  lateFeePerDayWei: string;
  days: number;
  spot: { id: string; name: string };
  slotStart: string;
  campusHash: string;
  ownerWallet: string;
  renterWallet: string;
};

export type Manifest = {
  v: 1;
  rentalId: string;
  phase: string;
  files: { name: string; sha256: string; bytes: number }[];
  createdAt: string;
};

export const termsHash = (terms: Terms): `0x${string}` => keccakUtf8(canonical(terms));

export const evidenceHash = (manifest: Manifest): `0x${string}` =>
  keccakUtf8(canonical(manifest));

/** Message the owner personal_signs (API spec §3). */
export const handoverMessage = (requestId: string) =>
  `CampusRent handover:${requestId}`;

/** secret = keccak256(signature bytes) */
export const secretFromSignature = (signature: `0x${string}`): `0x${string}` =>
  keccak256(signature);

/** Must match Solidity keccak256(abi.encode(secret)) */
export const handoverCodeHash = (secret: `0x${string}`): `0x${string}` =>
  keccak256(encodeAbiParameters([{ type: "bytes32" }], [secret]));

export const campusHashFromName = (nameOrDomain: string): `0x${string}` =>
  keccak256(stringToBytes(nameOrDomain.toLowerCase()));

export const CAMPUS_RENT_EIP712_NAME = "CampusRent";
export const CAMPUS_RENT_EIP712_VERSION = "1";

export const rentalOfferTypes = {
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
} as const;

export const studentVoucherTypes = {
  StudentVoucher: [
    { name: "wallet", type: "address" },
    { name: "campusId", type: "bytes32" },
    { name: "expiry", type: "uint40" },
  ],
} as const;

export type RentalOffer = {
  owner: `0x${string}`;
  renter: `0x${string}`;
  termsHash: `0x${string}`;
  rent: bigint;
  deposit: bigint;
  lateFeePerDay: bigint;
  durationDays: number;
  handoverDeadline: number;
  handoverCodeHash: `0x${string}`;
  nonce: bigint;
  sigDeadline: number;
};

export function eip712Domain(chainId: number, verifyingContract: `0x${string}`) {
  return {
    name: CAMPUS_RENT_EIP712_NAME,
    version: CAMPUS_RENT_EIP712_VERSION,
    chainId,
    verifyingContract,
  };
}

export { z } from "zod";
export * from "./schemas";
