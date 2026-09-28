import { z } from "zod";

export const weiString = z.string().regex(/^\d+$/);
export const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

export const listingCreateSchema = z.object({
  title: z.string().min(3).max(80),
  description: z.string().max(2000),
  category: z.enum([
    "camera",
    "electronics",
    "books",
    "cycle",
    "sports_gear",
    "instrument",
    "lab_equipment",
    "clothing",
    "other",
  ]),
  condition: z.enum(["new", "like_new", "good", "fair"]),
  imagePaths: z.array(z.string()).max(6),
  imageSha256s: z.array(z.string()),
  pricePerDayWei: weiString,
  depositWei: weiString,
  lateFeePerDayWei: weiString,
  minDays: z.number().int().min(1),
  maxDays: z.number().int().min(1).max(30),
  spotIds: z.array(z.string().uuid()).min(1),
  availability: z.array(
    z.object({
      dow: z.number().int().min(0).max(6),
      start: z.string(),
      end: z.string(),
    })
  ),
});

export const requestCreateSchema = z.object({
  listingId: z.string().uuid(),
  startDate: z.string(),
  days: z.number().int().min(1).max(30),
  spotId: z.string().uuid(),
  slotStart: z.string(),
  note: z.string().max(500).optional(),
});

export const offerBodySchema = z.object({
  offer: z.record(z.unknown()),
  signature: z.string(),
  handoverCodeHash: hex32,
});

export const syncBodySchema = z.object({
  txHash: hex32,
});
