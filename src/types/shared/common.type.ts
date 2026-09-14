// Import Types
import type { Prisma, PrismaClient } from "@prisma/client";

/* -------------------------------------- Types -------------------------------------- */

// Type connection ที่ repository ใช้ได้ทั้ง Prisma client ปกติและ transaction client
export type DbConnection = PrismaClient | Prisma.TransactionClient;

// Type object ธรรมดาที่ใช้กับการแปลง key หรือ payload ที่ยังไม่รู้ shape
export type PlainObject = Record<string, unknown>;

// Type callback สำหรับ workflow ที่ต้องทำงานใน transaction
export type TransactionCallback<T> = (
  transaction: Prisma.TransactionClient
) => Promise<T>;

// Type error ที่อาจมาจาก library หรือ error ภายในระบบ
export interface ErrorLike {
  type?: string;
  statusCode?: number;
  code?: string;
  message?: string;
  details?: unknown;
}

// Type response error มาตรฐานที่ส่งออกจาก middleware 
export type ErrorResponse = {
  statusCode: number;
  code: string;
  message: string;
  requestId?: string;
  details?: unknown;
} & Record<string, unknown>;

// Type รายละเอียด validation error ราย field
export interface ValidationIssueResponse {
  field: string | null;
  message: string;
}

// Type option กลางสำหรับ parser ที่แปลง validation error เป็น ApiError
export interface ParseOptions {
  statusCode?: number;
  code?: string;
  message?: string;
}

