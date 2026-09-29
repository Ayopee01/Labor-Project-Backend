// Import Library
import { z } from "zod";
// Import Config
import { ADMIN_PERMISSION_LEVELS, ADMIN_PERMISSIONS } from "../config/permission.config";
import { VEHICLE_OPERATION_STATUS } from "../constants/status";
import { DEFAULT_PAGE_LIMIT } from "../constants/pagination";
// Import Types
import { ACCOUNT_ROLES, USER_LIST_SHIFTS } from "../types/admin-workers.type";
import { ADMIN_AUDIT_ACTOR_TYPE_VALUES } from "../types/admin-audit.type";
import { GATE_CLIENT_STATUSES } from "../types/shared/gate-client.type";
import { WORKER_WORK_STATUS } from "../types/shared/worker-status.type";
// Import Utils
import { WORKER_NATIONALITIES, WORKER_SHIRT_TYPES } from "../utils/worker-code";

/* -------------------------------------- Formats -------------------------------------- */

// Format ข้อความที่ trim แล้วและห้ามว่าง
const trimmedString = z.string().trim().min(1, "Required.");

// Format รหัสผ่านใหม่ที่ user/admin กำหนดเอง
const newPasswordSchema = trimmedString.min(
  8,
  "Password must be at least 8 characters."
);

// Format client id ของ Gate ที่ระบบสร้างให้หรือ Admin ระบุเองได้
const gateClientIdString = trimmedString.regex(
  /^[A-Za-z0-9_-]{3,100}$/,
  "Use 3-100 characters: letters, numbers, underscore, or dash."
);

// Format สถานะ active/inactive
const activeStatusSchema = z.enum(["active", "inactive"]);

// Format วันที่ YYYY-MM-DD
const dateString = trimmedString.pipe(
  z.iso.date({ error: "Must use YYYY-MM-DD format." })
);

// Format วันเวลาแบบ ISO 8601 พร้อม timezone สำหรับ TicketCreatedAt จาก Gate
const dateTimeString = trimmedString.pipe(
  z.iso.datetime({ offset: true, error: "Must use ISO 8601 date-time format." })
);

// Format เวลาเฉพาะ HH:mm สำหรับกะประจำวันของ worker
const timeString = trimmedString.pipe(
  z.iso.time({ precision: -1, error: "Must use HH:mm format." })
);

// Format ชื่อกะของ worker ตามค่าใน master DB (LaborMaster.TimeWork)
const shiftNameSchema = z.enum(["Morning", "Evening", "Not specified"], {
  error: "ShiftName must be Morning, Evening or Not specified.",
});

// Function แปลง empty string เป็น undefined ก่อน validate optional field
const emptyStringToUndefined = (value: unknown): unknown =>
  value === "" ? undefined : value;

// Format วันที่ YYYY-MM-DD แบบ optional
const optionalDateString = z.preprocess(
  emptyStringToUndefined,
  dateString.optional()
);

// Format เวลา HH:mm แบบ optional ใช้กรองช่วงเวลาร่วมกับ date_from/date_to
const optionalTimeString = z.preprocess(
  emptyStringToUndefined,
  timeString.optional()
);

// Format วันเวลาแบบ ISO 8601 พร้อม timezone แบบ optional สำหรับ ForceUpdateAt/NotificationAt
const optionalDateTimeString = z.preprocess(
  emptyStringToUndefined,
  dateTimeString.optional()
);

// Format วันเวลา nullable สำหรับ PATCH ที่ต้องเคลียร์ค่าเป็น null
const nullableDateTimeString = z.preprocess(
  (value) => (value === "" ? null : value),
  dateTimeString.nullable().optional()
);

// Format URL แบบ https:// เท่านั้น สำหรับ Store link ของ Mobile App Version
const httpsUrlString = trimmedString
  .pipe(z.url({ error: "Must be a valid URL." }))
  .refine((value) => value.startsWith("https://"), {
    error: "Must use an https:// URL.",
  });

// Format URL https:// แบบ optional
const optionalHttpsUrlString = z.preprocess(
  emptyStringToUndefined,
  httpsUrlString.optional()
);

// Function นับจำนวนวันจาก dateFrom ถึง dateTo แบบรวมวันแรกและวันสุดท้าย
function countInclusiveCalendarDays(dateFrom: string, dateTo: string): number {
  const startAt = Date.parse(`${dateFrom}T00:00:00.000Z`);
  const endAt = Date.parse(`${dateTo}T00:00:00.000Z`);

  return Math.floor((endAt - startAt) / (24 * 60 * 60 * 1000)) + 1;
}

// Function บวกจำนวนเดือนแบบปฏิทินให้วันที่ YYYY-MM-DD (ใช้ตรวจช่วงวันที่ไม่เกิน N เดือน)
function addCalendarMonthsToDateString(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1 + months, day));

  return [
    String(next.getUTCFullYear()),
    String(next.getUTCMonth() + 1).padStart(2, "0"),
    String(next.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

// Function ตรวจว่า date_to ต้องไม่น้อยกว่า date_from
function checkDateRangeOrder(
  input: { date_from?: string; date_to?: string },
  context: z.RefinementCtx,
): void {
  if (input.date_from && input.date_to && input.date_from > input.date_to) {
    context.addIssue({
      code: "custom",
      path: ["date_to"],
      message: "date_to must be greater than or equal to date_from.",
    });
  }
}

// Function ตรวจว่า time_from/time_to ต้องมี date คู่กัน และถ้าวันเดียวกัน time_to ต้องไม่ก่อน time_from
function checkTimeRequiresDate(
  input: {
    date?: string;
    date_from?: string;
    date_to?: string;
    time_from?: string;
    time_to?: string;
  },
  context: z.RefinementCtx,
): void {
  const effectiveDateFrom = input.date ?? input.date_from;
  const effectiveDateTo = input.date ?? input.date_to;

  if (input.time_from && !effectiveDateFrom) {
    context.addIssue({
      code: "custom",
      path: ["time_from"],
      message: "time_from requires date or date_from.",
    });
  }

  if (input.time_to && !effectiveDateTo) {
    context.addIssue({
      code: "custom",
      path: ["time_to"],
      message: "time_to requires date or date_to.",
    });
  }

  if (
    input.time_from &&
    input.time_to &&
    effectiveDateFrom &&
    effectiveDateTo &&
    effectiveDateFrom === effectiveDateTo &&
    input.time_from > input.time_to
  ) {
    context.addIssue({
      code: "custom",
      path: ["time_to"],
      message: "time_to must be greater than or equal to time_from on the same date.",
    });
  }
}

// Format ข้อความ optional ที่ trim แล้ว (empty string = ไม่ระบุ)
const optionalTrimmedString = z.preprocess(
  emptyStringToUndefined,
  z.string().trim().optional()
);

// Format field optional ที่ยอมรับ null หรือ empty string เป็นไม่ระบุ
const nullableOptionalTrimmedString = z.preprocess(
  (value) => (value === "" || value === null ? undefined : value),
  z.string().trim().optional()
);

// Format field ที่ล้างค่าได้: undefined = ไม่แก้ค่าเดิม, null = ล้างค่า
const clearableTrimmedString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().trim().nullable().optional()
);

// Format client id ของ Gate แบบ optional สำหรับ body สร้างใหม่ ถ้าว่างให้ระบบสร้างให้
const optionalGateClientIdString = z.preprocess(
  emptyStringToUndefined,
  gateClientIdString.optional()
);

// Format สถานะ active/inactive โดย default เป็น active
const defaultActiveStatusSchema = z.preprocess(
  emptyStringToUndefined,
  activeStatusSchema.default("active")
);

// Format boolean สำหรับ query string ("true"/"false") เช่น has_issue ของ Operations board
const optionalBooleanQuery = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean().optional());

// Format สถานะ active/inactive แบบ optional
const optionalActiveStatusSchema = z.preprocess(
  emptyStringToUndefined,
  activeStatusSchema.optional()
);

// Format สถานะ Gate client จาก payload ของ Admin Settings
const gateClientStatusSchema = z.enum(GATE_CLIENT_STATUSES);

// Format สถานะ Gate client สำหรับ body สร้างใหม่ โดย default เป็น active
const defaultGateClientStatusSchema = z.preprocess(
  emptyStringToUndefined,
  gateClientStatusSchema.default("active")
);

// Format สถานะ Gate client แบบ optional สำหรับ body PATCH
const optionalGateClientStatusSchema = z.preprocess(
  emptyStringToUndefined,
  gateClientStatusSchema.optional()
);

// Format ค่าสัญชาติ worker ที่ใช้สร้างรหัส worker
const workerNationalitySchema = z.enum(WORKER_NATIONALITIES);

// Format ค่าสีเสื้อ worker ที่ใช้สร้างรหัส worker
const workerShirtTypeSchema = z.enum(WORKER_SHIRT_TYPES);

// Format สัญชาติ worker แบบ optional สำหรับ body PATCH/profile update
const optionalWorkerNationalitySchema = z.preprocess(
  emptyStringToUndefined,
  workerNationalitySchema.optional()
);

// Format สีเสื้อ worker แบบ optional สำหรับ body PATCH/profile update
const optionalWorkerShirtTypeSchema = z.preprocess(
  emptyStringToUndefined,
  workerShirtTypeSchema.optional()
);

// Format ข้อความ optional ที่แปลงเป็นตัวพิมพ์เล็ก
const optionalLowercaseString = z.preprocess(
  emptyStringToUndefined,
  z
    .string()
    .trim()
    .transform((value) => value.toLowerCase())
    .optional()
);

// Format platform ของ FCM ที่ Mobile ส่งมาตอน auth หรือ refresh push token
const pushPlatformSchema = z.preprocess(
  emptyStringToUndefined,
  z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(["android", "ios", "web", "unknown"]))
    .optional()
);

// Format ภาษาของ account
const accountLangSchema = z.preprocess(
  (value) => {
    const normalized = emptyStringToUndefined(value);

    if (typeof normalized !== "string") {
      return normalized;
    }

    const upper = normalized.trim().toUpperCase();
    const aliases: Record<string, string> = {
      MY: "MN",
      KM: "CN",
    };

    return aliases[upper] ?? upper;
  },
  z
    .string()
    .trim()
    .pipe(z.enum(["TH", "MN", "CN", "EN"]))
);

// Format เลขหน้าแบบ optional
const optionalPageNumber = z.preprocess(
  emptyStringToUndefined,
  z.coerce.number().int().min(1).optional()
);

// Format จำนวนต่อหน้าแบบ optional
const optionalLimitNumber = z.preprocess(
  emptyStringToUndefined,
  z.coerce.number().int().min(1).max(100).optional()
);

// Format เลขหน้าโดย default เป็น 1
const pageQuerySchema = z.preprocess(
  emptyStringToUndefined,
  z.coerce.number().int().min(1).default(1)
);

// Format จำนวนต่อหน้าโดย default ตาม DEFAULT_PAGE_LIMIT
const limitQuerySchema = z.preprocess(
  emptyStringToUndefined,
  z.coerce.number().int().min(1).max(100).default(DEFAULT_PAGE_LIMIT)
);

/* -------------------------------------- Common Schemas -------------------------------------- */

// Schema ID ที่เป็นเลขจำนวนเต็มบวก
export const idSchema = z.coerce.number().int().positive();

/* -------------------------------------- Auth Schemas -------------------------------------- */

// Schema body สำหรับเข้าสู่ระบบ
export const loginBodySchema = z.object({
  username: trimmedString,
  password: trimmedString,
  device_id: optionalTrimmedString,
  device_name: optionalTrimmedString,
  fcm_token: optionalTrimmedString,
  platform: pushPlatformSchema,
});

// Schema body สำหรับยืนยันเข้าสู่ระบบแทน session เดิม
export const confirmForceLoginBodySchema = z.object({
  login_challenge_token: trimmedString,
  device_id: trimmedString,
  device_name: trimmedString,
  fcm_token: optionalTrimmedString,
  platform: pushPlatformSchema,
});

// Schema body สำหรับ Worker Mobile ลงทะเบียนหรือ refresh FCM token นอกขั้นตอน login
export const workerPushTokenBodySchema = z.object({
  fcm_token: trimmedString,
  device_id: optionalTrimmedString,
  platform: pushPlatformSchema,
});

// Schema body สำหรับขอ token ใหม่ด้วย refresh token
export const refreshBodySchema = z.object({
  refresh_token: trimmedString,
});

// Schema body สำหรับเปลี่ยน password ของตัวเอง
export const changeOwnPasswordBodySchema = z.object({
  current_password: trimmedString,
  new_password: newPasswordSchema,
});

// Schema body สำหรับเปลี่ยนภาษาของตัวเอง
export const updateOwnLangBodySchema = z.object({
  lang: accountLangSchema,
});

// Schema body สำหรับแก้ไข profile ของตัวเอง
export const updateOwnProfileBodySchema = z.object({
  full_name: optionalTrimmedString,
  // ยอมรับ null เพื่อล้างค่าเดิมได้จริง (ต่างจาก full_name ที่ต้องไม่ว่างเสมอ) — undefined = ไม่แก้
  email: clearableTrimmedString,
  phone: clearableTrimmedString,
});

/* -------------------------------------- User Schemas -------------------------------------- */

// Schema ส่วน profile ที่ใช้ร่วมกันใน body สร้าง/แก้ไข user
const updateProfileInputSchema = z.object({
  nationality: optionalWorkerNationalitySchema,
  work_start_date: optionalDateString,
  shirt_type: optionalWorkerShirtTypeSchema,
  shirt_number: optionalTrimmedString,
});

// Schema body สำหรับสร้าง user
export const createUserBodySchema = z
  .object({
    username: optionalTrimmedString,
    full_name: trimmedString,
    phone: trimmedString,
    nationality: workerNationalitySchema,
    shirt_type: workerShirtTypeSchema,
    shirt_number: trimmedString,
    work_start_date: optionalDateString,
    shift_name: shiftNameSchema,
    time_in: timeString,
    time_out: timeString,
    status: defaultActiveStatusSchema,
  });

// Schema body สำหรับแก้ไข user
export const updateUserBodySchema = z.object({
  worker_code: optionalTrimmedString,
  full_name: optionalTrimmedString,
  phone: optionalTrimmedString,
  nationality: optionalWorkerNationalitySchema,
  position: optionalTrimmedString,
  shirt_type: optionalWorkerShirtTypeSchema,
  shirt_number: optionalTrimmedString,
  work_start_date: optionalDateString,
  shift_name: z.preprocess(emptyStringToUndefined, shiftNameSchema.optional()),
  time_in: z.preprocess(emptyStringToUndefined, timeString.optional()),
  time_out: z.preprocess(emptyStringToUndefined, timeString.optional()),
  profile: updateProfileInputSchema.optional(),
  status: optionalActiveStatusSchema,
});

// Schema body สำหรับ reset password ของ worker
export const resetPasswordBodySchema = z.object({
  new_password: newPasswordSchema,
});

/* -------------------------------------- Job Flow Schemas -------------------------------------- */

// Format TicketNumber/TicketNo ของ Gate — ตัวเลขล้วน 14 หลักเสมอ ห้ามมีตัวอักษรหรืออักษรพิเศษ
const boothJobIdSchema = trimmedString.regex(
  /^\d{14}$/,
  "Must be exactly 14 digits, numbers only."
);

// Schema สินค้าแต่ละรายการที่ Gate ส่งมา
const boothJobJobProductSchema = z.object({
  ProductCode: trimmedString,
  PackageCode: trimmedString,
  Quantity: z.coerce.number().int().positive(),
});

// Schema แผงและรายการสินค้าที่ Gate ส่งมา
const boothJobJobBoothSchema = z
  .object({
    BoothCode: trimmedString,
    Products: z.array(boothJobJobProductSchema).min(1),
  })
  .superRefine((input, context) => {
    const productKeys = new Set<string>();

    for (let index = 0; index < input.Products.length; index++) {
      const product = input.Products[index];
      const productKey = `${product.ProductCode}:${product.PackageCode}`;

      if (productKeys.has(productKey)) {
        context.addIssue({
          code: "custom",
          path: ["Products", index],
          message: "ProductCode + PackageCode must not be duplicated in the same booth.",
        });
      }

      productKeys.add(productKey);
    }
  });

// Schema request หลักสำหรับสร้างงานจาก Gate
export const boothJobJobBodySchema = z
  .object({
    // TicketNumber = ระดับรถ (TicketJob), TicketNo = Business Ticket ใต้รถคันนั้น (MarketJob)
    TicketNumber: boothJobIdSchema,
    TicketNo: boothJobIdSchema,
    TicketCreatedAt: dateTimeString,

    BoothCount: z.coerce.number().int().positive(),

    MarketCode: trimmedString,

    // จุดลงสินค้าของตลาดนี้ — บังคับส่งมาคู่กับ MarketCode ทุกครั้ง ตลาดเดียวกันส่งค่าซ้ำกันได้ปกติ
    DropoffPoint: trimmedString,

    LicensePlate: trimmedString,
    LicensePlateProvince: trimmedString,
    VehicleTypeCode: trimmedString,
    VehicleTypeName: trimmedString,

    Booths: z.array(boothJobJobBoothSchema).min(1),

    Dispatch: z.boolean(),

    // ถ้า Gate ส่งมาจะใช้เป็น Idempotency Key แทน hash ทั้ง body (ต้องคงค่าเดิมทุกครั้งที่ retry)
    IdempotencyKey: optionalTrimmedString,
  })
  .superRefine((input, context) => {
    // ตรวจ BoothCount ให้ตรงกับจำนวน Booth จริง
    if (input.BoothCount !== input.Booths.length) {
      context.addIssue({
        code: "custom",
        path: ["BoothCount"],
        message: "BoothCount must match Booths length.",
      });
    }

    // ตรวจ BoothCode ซ้ำใน Ticket เดียวกัน
    const boothCodes = new Set<string>();

    for (let index = 0; index < input.Booths.length; index++) {
      const booth = input.Booths[index];

      if (boothCodes.has(booth.BoothCode)) {
        context.addIssue({
          code: "custom",
          path: ["Booths", index, "BoothCode"],
          message: "BoothCode must not be duplicated.",
        });
      }

      boothCodes.add(booth.BoothCode);
    }
  });

// Schema body สำหรับเปิด Driver session จาก QR
export const driverQrSessionBodySchema = z.object({
  qr_token: trimmedString,
  // UUID ประจำเครื่องที่ Driver Web สร้างไว้ ใช้นับ active device ต่อรถ
  device_id: trimmedString,
});

// Schema body สำหรับ worker scan barcode เข้า Business Ticket
export const workerCheckInBarcodeBodySchema = z.object({
  ticket_no: trimmedString,
});

// Config เพดานจำนวนสินค้าตามคอลัมน์ Decimal(12,2)
const MAX_CONFIRMED_QUANTITY = 9_999_999_999.99;
// Format จำนวนสินค้าที่ยืนยันตอนส่งยอด (ห้าม coerce ค่าว่าง/null/boolean เป็น 0)
const confirmedQuantitySchema = z.preprocess(
  (value) =>
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "string" && value.trim() === "")
      ? undefined
      : value,
  z.coerce.number().min(0).max(MAX_CONFIRMED_QUANTITY)
);

// Schema original_package_code สำหรับกรณี Worker เปลี่ยน PackageCode
const workerTicketCompleteItemSchema = z.object({
  productCode: trimmedString,
  packageCode: trimmedString,
  original_package_code: trimmedString.optional(),
  confirmed_quantity: confirmedQuantitySchema,
});

// ต้องระบุ ticket_no เพราะ boothCode อาจซ้ำกันข้าม Business Ticket
export const workerTicketCompleteBodySchema = z.object({
  ticket_no: trimmedString,
  boothCode: trimmedString,
  items: z.array(workerTicketCompleteItemSchema).min(1),
});

// Schema query ประวัติงานของ worker
export const workerAssignmentHistoryQuerySchema = z
  .object({
    date: optionalDateString,
    date_from: optionalDateString,
    date_to: optionalDateString,
    page: optionalPageNumber,
    limit: optionalLimitNumber,
  })
  .superRefine((input, context) => {
    const hasDate = Boolean(input.date);
    const hasDateFrom = Boolean(input.date_from);
    const hasDateTo = Boolean(input.date_to);

    if (hasDate && (hasDateFrom || hasDateTo)) {
      context.addIssue({
        code: "custom",
        path: ["date"],
        message: "date cannot be combined with date_from/date_to.",
      });
    }

    if (hasDateFrom !== hasDateTo) {
      context.addIssue({
        code: "custom",
        path: hasDateFrom ? ["date_to"] : ["date_from"],
        message: "date_from and date_to must be sent together.",
      });
    }

    if (input.date_from && input.date_to) {
      checkDateRangeOrder(input, context);

      if (input.date_from > input.date_to) {
        return;
      }

      if (countInclusiveCalendarDays(input.date_from, input.date_to) > 31) {
        context.addIssue({
          code: "custom",
          path: ["date_to"],
          message: "Date range must not exceed 31 calendar days.",
        });
      }
    }
  });

// Schema query สรุปรายได้ของ worker (ไม่รับ query ใดๆ)
export const workerEarningsSummaryQuerySchema = z.object({}).strict();

// Config ค่า history_status ของ Work History (ALL = COMPLETED, CANCELLED หรือ REJECT_PENDING)
const historyStatusValues = ["ALL", "COMPLETED", "CANCELLED", "REJECT_PENDING"] as const;

// Schema query ประวัติงานรถของ Admin
export const adminTicketJobListQuerySchema = z
  .object({
    date: optionalDateString,
    date_from: optionalDateString,
    date_to: optionalDateString,
    page: optionalPageNumber,
    limit: optionalLimitNumber,
    search: optionalLowercaseString,
    status: optionalTrimmedString,
    // Format dropoff_point เป็น exact match แบบ case-insensitive
    dropoff_point: optionalTrimmedString,
    // แยกจาก status เดิมโดยตั้งใจ — ส่งมาพร้อมกันได้ทั้งคู่ และรวมกันแบบ AND (ดู listTicketJobs)
    history_status: z.preprocess(
      emptyStringToUndefined,
      z.enum(historyStatusValues).optional()
    ),
  })
  .superRefine(checkDateRangeOrder);

// Config ค่า operation_status ที่กรองได้
const vehicleOperationStatusValues = [
  VEHICLE_OPERATION_STATUS.READY_NOW,
  VEHICLE_OPERATION_STATUS.WAIT_UNLOAD,
  VEHICLE_OPERATION_STATUS.WAIT_WORKER,
  VEHICLE_OPERATION_STATUS.WORKING,
  VEHICLE_OPERATION_STATUS.COMPLETED,
  VEHICLE_OPERATION_STATUS.CANCELLED,
  VEHICLE_OPERATION_STATUS.REJECT,
] as const;

// Schema query บอร์ดจัดการงานรถของ Admin
export const adminTicketJobOperationsQuerySchema = z
  .object({
    date: optionalDateString,
    date_from: optionalDateString,
    date_to: optionalDateString,
    // เวลา HH:mm ใช้ร่วมกับ date/date_from และ date/date_to เพื่อกรองแทนเต็มวัน
    time_from: optionalTimeString,
    time_to: optionalTimeString,
    page: optionalPageNumber,
    limit: optionalLimitNumber,
    search: optionalLowercaseString,
    operation_status: z.preprocess(
      emptyStringToUndefined,
      z.enum(vehicleOperationStatusValues).optional()
    ),
    // Format status กรองจาก TicketJob.status ตรง ไม่ใช่ operation_status
    status: optionalTrimmedString,
    // has_issue = true กรองเฉพาะรถที่มีอย่างน้อย 1 แผงสถานะ REJECT ค้างอยู่ (market_summary.rejected > 0)
    has_issue: optionalBooleanQuery,
    // Format dropoff_point ต้องคำนวณก่อน summary และ pagination
    dropoff_point: optionalTrimmedString,
  })
  .superRefine((input, context) => {
    checkDateRangeOrder(input, context);
    checkTimeRequiresDate(input, context);
  });

// Config field ที่ใช้เรียงรายงานผลงาน worker
const adminAuditWorkerPerformanceSortByValues = [
  "accept_rate",
  "total_assigned",
  "accepted",
  "accept_timeout",
  "scan_timeout",
  "completed",
  "admin_cancelled",
  "worker_code",
] as const;

// Schema query รายงานผลงาน worker
export const adminAuditWorkerPerformanceQuerySchema = z
  .object({
    worker_code: optionalTrimmedString,
    date_from: optionalDateString,
    date_to: optionalDateString,
    page: pageQuerySchema,
    limit: limitQuerySchema,
    sort_by: z.preprocess(
      emptyStringToUndefined,
      z.enum(adminAuditWorkerPerformanceSortByValues).optional()
    ),
    sort_order: z.preprocess(
      emptyStringToUndefined,
      z.enum(["asc", "desc"]).optional()
    ),
  })
  .strict()
  .superRefine((input, context) => {
    if (Boolean(input.date_from) !== Boolean(input.date_to)) {
      context.addIssue({
        code: "custom",
        path: input.date_from ? ["date_to"] : ["date_from"],
        message: "date_from and date_to must be sent together.",
      });
    }

    checkDateRangeOrder(input, context);

    // Format จำกัดช่วงวันสูงสุดเพื่อกัน query หนักเกินไป
    if (
      input.date_from &&
      input.date_to &&
      input.date_from <= input.date_to &&
      countInclusiveCalendarDays(input.date_from, input.date_to) > 92
    ) {
      context.addIssue({
        code: "custom",
        path: ["date_to"],
        message: "Date range must not exceed 92 calendar days.",
      });
    }
  });

// Config ค่า actor_type ที่กรอง audit events ได้
const adminAuditEventsActorTypeValues = [
  ...ADMIN_AUDIT_ACTOR_TYPE_VALUES,
] as const;

// Config ค่า quick_filter ของ audit events (กรองเฉพาะ data/pagination ไม่มีผลต่อ summary)
const adminAuditQuickFilterValues = [
  "has_vehicle",
  "system",
  "critical",
  "admin",
  "has_reason",
] as const;

// Schema query รายการ audit events
export const adminAuditEventsQuerySchema = z
  .object({
    search: optionalTrimmedString,
    actor_type: z.preprocess(
      emptyStringToUndefined,
      z.enum(adminAuditEventsActorTypeValues).optional()
    ),
    event_type: optionalTrimmedString,
    date_from: optionalDateString,
    date_to: optionalDateString,
    quick_filter: z.preprocess(
      emptyStringToUndefined,
      z.enum(adminAuditQuickFilterValues).optional()
    ),
    page: pageQuerySchema,
    limit: limitQuerySchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (Boolean(input.date_from) !== Boolean(input.date_to)) {
      context.addIssue({
        code: "custom",
        path: input.date_from ? ["date_to"] : ["date_from"],
        message: "date_from and date_to must be sent together.",
      });
    }

    checkDateRangeOrder(input, context);

    // Format จำกัดช่วงวันสูงสุดเพื่อกัน query หนักเกินไป
    if (
      input.date_from &&
      input.date_to &&
      input.date_from <= input.date_to &&
      countInclusiveCalendarDays(input.date_from, input.date_to) > 92
    ) {
      context.addIssue({
        code: "custom",
        path: ["date_to"],
        message: "Date range must not exceed 92 calendar days.",
      });
    }
  });

// Schema body เหตุผลการยกเลิกของ Admin
export const adminCancelBodySchema = z.object({
  reason_code: optionalTrimmedString,
  reason_text: nullableOptionalTrimmedString,
});

// Schema body สำหรับยกเลิก assignment ของ worker (reason_code บังคับ)
export const adminCancelAssignmentBodySchema = z.object({
  reason_code: trimmedString,
  reason_text: nullableOptionalTrimmedString,
});

// Schema body สำหรับยกเลิกงานตาม scope ของ ticket_no, boothCode และ worker_code
export const adminTicketJobAssignmentCancelBodySchema = z.object({
  ticket_number: trimmedString,
  ticket_no: nullableOptionalTrimmedString,
  boothCode: nullableOptionalTrimmedString,
  worker_code: nullableOptionalTrimmedString,
  reason_code: trimmedString,
  reason_text: nullableOptionalTrimmedString,
});

// Schema body สำหรับ Admin เพิ่ม worker เข้างานรถ
export const adminAssignWorkersBodySchema = z.object({
  worker_codes: z.array(trimmedString).min(1),
  reason_code: trimmedString,
  reason_text: nullableOptionalTrimmedString,
});

// Schema รายการสินค้าที่ Admin ส่งยอดแทน
const adminOverrideCountItemSchema = z.object({
  productCode: trimmedString,
  packageCode: trimmedString,
  actual_quantity: confirmedQuantitySchema,
});

// Schema body สำหรับ Admin ส่งยอดแทน worker
export const adminOverrideCountBodySchema = z.object({
  reason_code: trimmedString,
  reason_text: nullableOptionalTrimmedString,
  counts: z.array(adminOverrideCountItemSchema).min(1),
});

// Schema body สำหรับเปิด/ปิด dispatch ของงานรถ
export const adminVehicleWaitBodySchema = z.object({
  dispatch: z.boolean(),
  reason_code: trimmedString,
  reason_text: nullableOptionalTrimmedString,
});

// Schema body สำหรับปล่อยทีม worker กลับคิว
export const adminReleaseWorkersBodySchema = z.object({
  reason_code: trimmedString,
  reason_text: nullableOptionalTrimmedString,
});

// Schema query สำหรับรายได้ Worker รายวัน พร้อม alias ของ frontend
export const adminDailyWorkerIncomeQuerySchema = z
  .object({
    date: optionalDateString,
    date_from: optionalDateString,
    date_to: optionalDateString,
    from: optionalDateString,
    to: optionalDateString,
    worker_code: optionalTrimmedString,
    workerCode: optionalTrimmedString,
    status: optionalTrimmedString,
    shift: z.preprocess(
      emptyStringToUndefined,
      z.enum(["Morning", "Evening"]).optional()
    ),
    search: optionalLowercaseString,
    keyword: optionalLowercaseString,
    page: optionalPageNumber,
    limit: optionalLimitNumber,
    pageSize: optionalLimitNumber,
  })
  .transform((input) => ({
    date: input.date,
    date_from: input.date_from ?? input.from,
    date_to: input.date_to ?? input.to,
    worker_code: input.worker_code ?? input.workerCode,
    status: input.status,
    shift: input.shift,
    search: input.search ?? input.keyword,
    page: input.page,
    limit: input.limit ?? input.pageSize,
  }));

// Schema query รายงานค่าลงสินค้าแผงค้ารายวัน (date_from/date_to บังคับ และไม่เกิน 31 วัน)
export const adminDailyStallFeeQuerySchema = z
  .object({
    date_from: dateString,
    date_to: dateString,
    search: optionalLowercaseString,
    product_code: optionalTrimmedString,
    package_code: optionalTrimmedString,
    page: pageQuerySchema,
    limit: limitQuerySchema,
  })
  .strict()
  .superRefine((input, context) => {
    checkDateRangeOrder(input, context);

    if (input.date_from > input.date_to) {
      return;
    }

    if (countInclusiveCalendarDays(input.date_from, input.date_to) > 31) {
      context.addIssue({
        code: "custom",
        path: ["date_to"],
        message: "Date range must not exceed 31 calendar days.",
      });
    }
  });

// Config จำนวนเดือนสูงสุดของช่วงวันที่ในรายงานค่าลงสินค้ารายเดือน
export const MONTHLY_STALL_FEE_MAX_RANGE_MONTHS = 6;

// Schema query รายงานค่าลงสินค้าแผงค้ารายเดือน (date_from/date_to บังคับ และไม่เกิน N เดือนตามปฏิทิน)
export const adminMonthlyStallFeeQuerySchema = z
  .object({
    date_from: dateString,
    date_to: dateString,
    market_search: optionalTrimmedString,
    booth_search: optionalTrimmedString,
    // ไม่ผูกกับ whitelist คงที่ — ยอมรับสีใดก็ได้ที่มีจริงใน master data (รวมถึง MIXED/UNKNOWN ที่แอปคำนวณเอง)
    shirt_color: optionalTrimmedString,
    page: pageQuerySchema,
    limit: limitQuerySchema,
  })
  .strict()
  .superRefine((input, context) => {
    checkDateRangeOrder(input, context);

    if (input.date_from > input.date_to) {
      return;
    }

    if (input.date_to > addCalendarMonthsToDateString(input.date_from, MONTHLY_STALL_FEE_MAX_RANGE_MONTHS)) {
      context.addIssue({
        code: "custom",
        path: ["date_to"],
        message: `Date range must not exceed ${MONTHLY_STALL_FEE_MAX_RANGE_MONTHS} months.`,
      });
    }
  });

// Schema body สำหรับต่อเวลา scan ของ worker
export const adminExtendScanDeadlineBodySchema = z.object({
  minutes: z.coerce.number().int().positive().max(240),
  worker_codes: z.array(trimmedString).min(1).optional(),
  reason_code: trimmedString,
  reason_text: nullableOptionalTrimmedString,
});

// Schema body สำหรับ Admin บังคับเปลี่ยนสถานะ worker
export const adminForceWorkerStatusBodySchema = z.object({
  status: z.enum([
    WORKER_WORK_STATUS.OPEN_APP,
    WORKER_WORK_STATUS.READY,
    WORKER_WORK_STATUS.BREAK,
  ]),
  reason_code: trimmedString,
  reason_text: nullableOptionalTrimmedString,
});

/* -------------------------------------- Settings Schemas -------------------------------------- */

// Schema body สำหรับสร้าง Gate client
export const createGateClientBodySchema = z.object({
  client_id: optionalGateClientIdString,
  name: trimmedString,
  status: defaultGateClientStatusSchema,
});

// Schema body สำหรับแก้ไข Gate client
export const updateGateClientBodySchema = z
  .object({
    name: optionalTrimmedString,
    status: optionalGateClientStatusSchema,
  })
  .refine((value) => value.name !== undefined || value.status !== undefined, {
    message: "At least one field is required.",
  });

// Schema body สำหรับแก้ไข runtime settings
export const updateSystemSettingsBodySchema = z
  .object({
    driver_session_ttl_hours: z.coerce.number().int().positive().max(168).optional(),
    worker_accept_deadline_seconds: z.coerce.number().int().positive().max(600).optional(),
    worker_accept_timeout_limit: z.coerce.number().int().positive().max(20).optional(),
    worker_scan_deadline_minutes: z.coerce.number().int().positive().max(240).optional(),
    worker_scan_warning_before_minutes: z.coerce.number().int().positive().max(240).optional(),
    worker_scan_team_remaining_minutes: z.coerce.number().int().positive().max(240).optional(),
    worker_break_duration_minutes: z.coerce.number().int().positive().max(240).optional(),
    worker_break_limit: z.coerce.number().int().min(0).max(20).optional(),
    // ต้องไม่สั้นกว่ากะที่ยาวที่สุด ไม่งั้นตัวนับการพักหมดอายุกลางกะ
    worker_break_count_ttl_hours: z.coerce.number().int().min(24).max(168).optional(),
    worker_break_retry: z.coerce.number().int().positive().max(240).optional(),
    worker_presence_stale_seconds: z.coerce.number().int().positive().max(3600).optional(),
    vendor_confirm_timeout_hours: z.coerce.number().int().positive().max(168).optional(),
    vendor_reconfirm_timeout_hours: z.coerce.number().int().positive().max(168).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one setting is required.",
  });

// Format BuildNumber ของ Mobile App Version — เป็นตัวหลักสำหรับเทียบ Version ห้ามเป็นค่าลบ/ศูนย์
const buildNumberSchema = z.coerce.number().int().positive();

// Function ตรวจว่า ReleaseNotificationAt ไม่ช้ากว่า ForceUpdateAt
function refineReleaseNotificationTiming(
  value: {
    release_notification_at?: string;
    force_update_at?: string;
  },
  context: import("zod").core.$RefinementCtx
): void {
  if (
    value.release_notification_at &&
    value.force_update_at &&
    new Date(value.release_notification_at).getTime() > new Date(value.force_update_at).getTime()
  ) {
    context.addIssue({
      code: "custom",
      path: ["release_notification_at"],
      message: "release_notification_at must not be later than force_update_at.",
    });
  }
}

// Schema body สำหรับสร้าง mobile app version
export const createMobileAppVersionBodySchema = z
  .object({
    version: trimmedString,
    build_number: buildNumberSchema,
    release_at: optionalDateTimeString,
    android_download_url: optionalHttpsUrlString,
    ios_download_url: optionalHttpsUrlString,
    release_message: optionalTrimmedString,
    release_notes: optionalTrimmedString,
    // มีค่า = บังคับ update ตั้งแต่เวลานี้ / ไม่มีค่า = update แบบไม่บังคับทันที
    force_update_at: optionalDateTimeString,
    // null/ไม่ส่งมา = ส่ง FCM แจ้งเตือนล่วงหน้าทันที, มีค่า = ตั้งเวลาส่งผ่าน BullMQ
    release_notification_at: optionalDateTimeString,
  })
  .superRefine(refineReleaseNotificationTiming);

// Schema body สำหรับแก้ไข mobile app version
export const updateMobileAppVersionBodySchema = z
  .object({
    version: optionalTrimmedString,
    build_number: buildNumberSchema.optional(),
    release_at: optionalDateTimeString,
    android_download_url: optionalHttpsUrlString,
    ios_download_url: optionalHttpsUrlString,
    release_message: optionalTrimmedString,
    release_notes: optionalTrimmedString,
    force_update_at: nullableDateTimeString,
    release_notification_at: nullableDateTimeString,
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required.",
  });

// Schema query สำหรับ app เช็ค version ล่าสุด
export const mobileAppVersionCheckQuerySchema = z.object({
  platform: z.enum(["android", "ios"]).optional(),
  version: optionalTrimmedString,
  build_number: z.coerce.number().int().min(0).optional(),
});

// Schema body สำหรับแก้ไขสิทธิ์ของ Admin account
export const updateAccountPermissionsBodySchema = z.object({
  permission_level: z.enum(ADMIN_PERMISSION_LEVELS),
  status: optionalActiveStatusSchema,
  permissions: z
    .array(z.enum(ADMIN_PERMISSIONS))
    .default([]),
});

// Schema body สำหรับสร้าง Admin account
export const createAdminAccountBodySchema = z.object({
  username: trimmedString,
  password: newPasswordSchema,
  full_name: trimmedString,
  position: optionalTrimmedString,
  email: optionalTrimmedString,
  phone: optionalTrimmedString,
  status: defaultActiveStatusSchema,
  permission_level: z.enum(ADMIN_PERMISSION_LEVELS),
  permissions: z
    .array(z.enum(ADMIN_PERMISSIONS))
    .default([]),
});

// Schema body สำหรับแก้ไขข้อมูลพื้นฐานของ Admin account
export const updateAdminAccountBodySchema = z.object({
  full_name: optionalTrimmedString,
  position: optionalTrimmedString,
  email: optionalTrimmedString,
  phone: optionalTrimmedString,
});

// Schema ค่า runtime settings ทั้งชุด
export const runtimeSettingsSchema = z.object({
  driver_session_ttl_hours: z.coerce
    .number()
    .int()
    .positive(),
  worker_accept_deadline_seconds: z.coerce
    .number()
    .int()
    .positive(),
  worker_accept_timeout_limit: z.coerce
    .number()
    .int()
    .positive(),
  worker_scan_deadline_minutes: z.coerce
    .number()
    .int()
    .positive(),
  worker_scan_warning_before_minutes: z.coerce
    .number()
    .int()
    .positive(),
  worker_scan_team_remaining_minutes: z.coerce
    .number()
    .int()
    .positive(),
  worker_break_duration_minutes: z.coerce
    .number()
    .int()
    .positive(),
  worker_break_limit: z.coerce
    .number()
    .int()
    .min(0),
  worker_break_count_ttl_hours: z.coerce
    .number()
    .int()
    .positive(),
  worker_break_retry: z.coerce
    .number()
    .int()
    .positive(),
  worker_presence_stale_seconds: z.coerce
    .number()
    .int()
    .positive(),
  vendor_confirm_timeout_hours: z.coerce
    .number()
    .int()
    .positive(),
  vendor_reconfirm_timeout_hours: z.coerce
    .number()
    .int()
    .positive(),
});

/* -------------------------------------- Query Schemas -------------------------------------- */

// Format กะที่ใช้กรองรายชื่อ user แบบ optional
const optionalUserListShiftSchema = z.preprocess(
  emptyStringToUndefined,
  z.enum(USER_LIST_SHIFTS).optional()
);

// Schema query page/limit โดยมีค่า default
export const paginationQuerySchema = z.object({
  page: pageQuerySchema,
  limit: limitQuerySchema,
  search: optionalLowercaseString,
  status: optionalActiveStatusSchema,
  worker_code: optionalTrimmedString,
  full_name: optionalTrimmedString,
  shirt_number: optionalTrimmedString,
  shift: optionalUserListShiftSchema,
});

// Schema query page/limit แบบไม่มี default (ไม่ส่ง = ดึงทั้งหมด)
export const optionalPaginationQuerySchema = z.object({
  page: z.preprocess(emptyStringToUndefined, z.coerce.number().int().min(1).optional()),
  limit: z.preprocess(emptyStringToUndefined, z.coerce.number().int().min(1).max(100).optional()),
});

/* -------------------------------------- Token Schemas -------------------------------------- */

// Schema เวลา iat/exp ที่ใช้ร่วมกันใน token payload
const tokenTimestampsSchema = {
  iat: z.number().optional(),
  exp: z.number().optional(),
};

// Schema payload ของ access token
export const accessTokenPayloadSchema = z.object({
  account_id: z.number().int().positive(),
  role: z.enum(ACCOUNT_ROLES),
  permission_level: optionalTrimmedString.nullable(),
  permissions: z.array(z.enum(ADMIN_PERMISSIONS)).optional(),
  session_id: z.number().int().positive(),
  token_type: z.literal("access"),
  ...tokenTimestampsSchema,
});

// Schema payload ของ refresh token
export const refreshTokenPayloadSchema = z.object({
  account_id: z.number().int().positive(),
  role: z.enum(ACCOUNT_ROLES),
  session_id: z.number().int().positive(),
  token_type: z.literal("refresh"),
  ...tokenTimestampsSchema,
});

// Schema payload ของ login challenge token
export const loginChallengeTokenPayloadSchema = z.object({
  account_id: z.number().int().positive(),
  role: z.enum(ACCOUNT_ROLES),
  old_session_id: z.number().int().positive(),
  new_device_id: trimmedString,
  token_type: z.literal("login_challenge"),
  ...tokenTimestampsSchema,
});
