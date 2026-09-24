// Import Library
import { Prisma } from "@prisma/client";
// Import Utils
import { client } from "./shared/repository-utils";
import { mapLineActionToken } from "./shared/mappers";
// Import Types
import type { DbConnection } from "../types/shared/common.type";
import type { LineActionTokenDto, LineDevSubmissionItem, TicketRatingDto } from "../types/line.type";
// Import Config
import { TICKET_STATUS } from "../constants/status";

/* -------------------------------------- Functions -------------------------------------- */

// Function ค้นหา LINE action token จาก DB
export async function findLineActionToken(
  token: string,
  connection?: DbConnection
): Promise<LineActionTokenDto | null> {
  const db = client(connection);
  const record = await db.lineActionToken.findUnique({
    where: {
      token,
    },
  });

  return record ? mapLineActionToken(record) : null;
}

// Function ทำเครื่องหมาย LINE action token ว่าถูกใช้แล้วแบบ atomic (WHERE used_at IS NULL) — คืน true
// เฉพาะตอนที่ตัวเรียกนี้เป็นคนอ้างสิทธิ์ใช้จริง กัน Token เดิมถูกใช้ซ้ำเมื่อ LINE Redeliver Event เดิม
export async function claimLineActionTokenUsed(
  id: number,
  connection?: DbConnection
): Promise<boolean> {
  const db = client(connection);
  const result = await db.lineActionToken.updateMany({
    where: {
      id,
      usedAt: null,
    },
    data: {
      usedAt: new Date(),
    },
  });

  return result.count === 1;
}

// Function ดึง Submission สำหรับหน้า LINE dev tester
export async function listLineDevSubmissions(
  connection?: DbConnection
): Promise<LineDevSubmissionItem[]> {
  const db = client(connection);
  const submissions = await db.ticketCompletionSubmission.findMany({
    include: {
      submittedByAccount: {
        select: {
          username: true,
          fullName: true,
        },
      },
      submittedByWorker: {
        select: {
          laborCode: true,
          fullName: true,
        },
      },
      ticket: {
        include: {
          ticketJob: true,
          marketJob: true,
          products: {
            orderBy: {
              id: "asc",
            },
          },
        },
      },
    },
    orderBy: [
      { createdAt: "desc" },
      { id: "desc" },
    ],
  });

  return submissions.map((submission) => ({
    submission_id: submission.id,
    ticket_id: submission.ticketId,
    submission_status: submission.status,
    ticket_status: submission.ticket.status,
    actionable:
      submission.status === TICKET_STATUS.DELIVERED &&
      submission.ticket.status === TICKET_STATUS.DELIVERED,
    ticket_number: submission.ticket.ticketJob.ticketNumber,
    ticket_no: submission.ticket.marketJob.ticketNo,
    license_plate: submission.ticket.ticketJob.licensePlate,
    market_code: submission.ticket.marketJob.marketCode,
    market_name: submission.ticket.marketJob.marketName,
    boothCode: submission.ticket.boothCode,
    boothName: submission.ticket.boothName,
    submitted_by_code: submission.submittedByAccount?.username ?? submission.submittedByWorker?.laborCode ?? null,
    submitted_by_name: submission.submittedByAccount?.fullName ?? submission.submittedByWorker?.fullName ?? null,
    submitted_by_role: submission.submittedByRole,
    submitted_at: submission.createdAt.toISOString(),
    confirmed_at: submission.confirmedAt?.toISOString() ?? null,
    rejected_at: submission.rejectedAt?.toISOString() ?? null,
    reject_reason: submission.rejectReason,
    products: submission.ticket.products.map((product) => ({
      productCode: product.productCode,
      productName: product.productName,
      packageCode: product.packageCode,
      packageName: product.packageName,
      expected_quantity: product.quantity.toString(),
      submitted_quantity: product.confirmedQuantity?.toString() ?? null,
    })),
  }));
}

// Function จัดการ เป็น ticket rating DTO จาก DB
function mapTicketRating(rating: {
  id: number;
  ticketId: number;
  submissionId: number;
  lineUserId: string;
  targetType: string | null;
  score: number;
  ratedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}): TicketRatingDto {
  return {
    id: rating.id,
    ticket_id: rating.ticketId,
    submission_id: rating.submissionId,
    line_user_id: rating.lineUserId,
    target_type: rating.targetType,
    score: rating.score,
    rated_at: rating.ratedAt.toISOString(),
    created_at: rating.createdAt.toISOString(),
    updated_at: rating.updatedAt.toISOString(),
  };
}

// Function สร้างคะแนนความพึงพอใจของ ticket ใบหนึ่งจาก DB — ticket_id unique (@@unique([ticketId])
// ใน schema) จึงมีได้คะแนนเดียวต่อ ticket เท่านั้น ถ้ามีอยู่แล้วคืนคะแนนเดิมแทนการเขียนทับ
export async function upsertTicketRating(
  input: {
    ticket_id: number;
    submission_id: number;
    line_user_id: string;
    target_type?: string | null;
    score: number;
  },
  connection?: DbConnection
): Promise<TicketRatingDto> {
  const db = client(connection);

  try {
    return mapTicketRating(
      await db.ticketRating.create({
        data: {
          ticketId: input.ticket_id,
          submissionId: input.submission_id,
          lineUserId: input.line_user_id,
          targetType: input.target_type ?? null,
          score: input.score,
        },
      })
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const existingRating = await db.ticketRating.findUnique({
        where: {
          ticketId: input.ticket_id,
        },
      });

      if (existingRating) {
        return mapTicketRating(existingRating);
      }
    }

    throw error;
  }
}
