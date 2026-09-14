// Import Library
import crypto from "crypto";
import { Prisma } from "@prisma/client";
// Import Utils
import { client } from "./repository-utils";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";
import type { LineActionTokenDto, VendorTicketAction } from "../../types/line.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function อ่านค่า duration เป็น milliseconds จาก DB
function parseDurationToMilliseconds(value: string | undefined): number {
  const defaultTtlMs = 7 * 24 * 60 * 60 * 1000;

  if (!value) {
    return defaultTtlMs;
  }

  const match = value.trim().match(/^(\d+)\s*([smhd])?$/i);

  if (!match) {
    return defaultTtlMs;
  }

  const amount = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return amount * (multipliers[unit] ?? multipliers.s);
}

// Function สร้าง LINE action token expires at จาก DB
function buildLineActionTokenExpiresAt(): Date {
  return new Date(
    Date.now() + parseDurationToMilliseconds(process.env.VENDOR_ACTION_TOKEN_EXPIRES_IN)
  );
}

// Function จัดการ เป็น LINE action token DTO จาก DB
function toLineActionTokenDto(record: {
  id: number;
  token: string;
  action: string;
  ticketId: number;
  submissionId: number;
  boothCode: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): LineActionTokenDto {
  return {
    id: record.id,
    token: record.token,
    action: record.action as VendorTicketAction,
    ticket_id: record.ticketId,
    submission_id: record.submissionId,
    boothCode: record.boothCode,
    expires_at: record.expiresAt.toISOString(),
    used_at: record.usedAt?.toISOString() ?? null,
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
  };
}

// Function สร้าง random LINE action token จาก DB
function createRandomLineActionToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

// Function สร้าง LINE action token จาก DB
export async function createLineActionToken(
  input: {
    action: VendorTicketAction;
    ticket_id: number;
    submission_id: number;
    boothCode: string;
  },
  connection?: DbConnection
): Promise<LineActionTokenDto> {
  const db = client(connection);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const token = await db.lineActionToken.create({
        data: {
          token: createRandomLineActionToken(),
          action: input.action,
          ticketId: input.ticket_id,
          submissionId: input.submission_id,
          boothCode: input.boothCode,
          expiresAt: buildLineActionTokenExpiresAt(),
        },
      });

      return toLineActionTokenDto(token);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002" &&
        attempt < 2
      ) {
        continue;
      }

      throw error;
    }
  }

  throw new Error("Unable to create LINE action token.");
}
