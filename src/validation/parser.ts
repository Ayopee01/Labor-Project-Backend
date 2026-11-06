// Import Library
import type { ZodError, ZodType } from "zod";
// Import Types
import type { ParseOptions, ValidationIssueResponse } from "../types/shared/common.type";
// Import Validation
import { idSchema } from "./schemas";
// Import Utils
import ApiError from "../utils/api-error";

/* -------------------------------------- Parsers -------------------------------------- */

// Function จัดรูปแบบ zod issues สำหรับ validation
function formatZodIssues(error: ZodError): ValidationIssueResponse[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join(".") : null,
    message: issue.message,
  }));
}

// Function สร้าง validation error สำหรับ validation
function createValidationError(error: ZodError, options: ParseOptions = {}): ApiError {
  return new ApiError(
    options.statusCode ?? 400,
    options.code ?? "VALIDATION_ERROR",
    options.message ?? "Invalid request data.",
    {
      validation_errors: formatZodIssues(error),
    }
  );
}

// Function อ่าน request ด้วย Zod schema และคืน ApiError มาตรฐานเมื่อ validation ไม่ผ่าน
export function parseWithSchema<T>(
  schema: ZodType<T>,
  input: unknown,
  options?: ParseOptions
): T {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw createValidationError(result.error, options);
  }

  return result.data;
}

// Function อ่าน reference แบบข้อความจาก path param แล้ว trim (ถ้าว่าง throw 400 ด้วย code/message ที่ส่งมา)
export function parseRequiredReference(value: unknown, code: string, message: string): string {
  const reference = String(value ?? "").trim();

  if (!reference) {
    throw new ApiError(400, code, message);
  }

  return reference;
}

// Function อ่านค่า ID ที่เป็นเลขจำนวนเต็มบวก
export function parseId(value: unknown): number {
  return parseWithSchema(idSchema, value, {
    code: "VALIDATION_ERROR",
    message: "Invalid id.",
  });
}
