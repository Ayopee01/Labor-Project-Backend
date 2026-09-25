// Import Library
import { z } from "zod";
import { ADMIN_PERMISSION_LEVELS, ADMIN_PERMISSIONS } from "../config/permission.config";
import { VEHICLE_OPERATION_STATUS } from "../constants/status";
import { DEFAULT_PAGE_LIMIT } from "../constants/pagination";
import { ACCOUNT_ROLES, USER_LIST_SHIFTS } from "../types/admin-workers.type";
import { ADMIN_AUDIT_ACTOR_TYPE_VALUES } from "../types/admin-audit.type";
import { GATE_CLIENT_STATUSES } from "../types/shared/gate-client.type";
import { WORKER_WORK_STATUS } from "../types/shared/worker-status.type";
import { WORKER_NATIONALITIES, WORKER_SHIRT_TYPES } from "../utils/worker-code";

/* -------------------------------------- Formats -------------------------------------- */

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

const activeStatusSchema = z.enum(["active", "inactive"]);

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

// Format ชื่อกะของ worker ตามค่าที่ใช้จริงใน master DB (LaborMaster.TimeWork) — backend ไม่คำนวณชื่อกะเอง
const shiftNameSchema = z.enum(["Morning", "Evening", "Not specified"], {
  error: "ShiftName must be Morning, Evening or Not specified.",
});

// Function แปลง empty string เป็น undefined ก่อน validate optional field
const emptyStringToUndefined = (value: unknown): unknown =>
  value === "" ? undefined : value;

const optionalDateString = z.preprocess(
  emptyStringToUndefined,
  dateString.optional()
);

// Format เวลา HH:mm optional สำหรับ narrow ช่วง date_from/date_to ของ query ที่กรองแบบ createdAt range
// (เช่น admin vehicle-jobs operations) ใช้ timeString เดียวกับกะประจำวันของ worker
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

const optionalHttpsUrlString = z.preprocess(
  emptyStringToUndefined,
  httpsUrlString.optional()
);

function countInclusiveCalendarDays(dateFrom: string, dateTo: string): number {
  const startAt = Date.parse(`${dateFrom}T00:00:00.000Z`);
  const endAt = Date.parse(`${dateTo}T00:00:00.000Z`);

  return Math.floor((endAt - startAt) / (24 * 60 * 60 * 1000)) + 1;
}

// Function บวกจำนวนเดือนแบบปฏิทินจริงเข้ากับ date string (YYYY-MM-DD) — ใช้ตรวจ cap ช่วงวันที่แบบ
// "ไม่เกิน N เดือน" ที่ต้องรองรับข้ามปี/ปีอธิกสุรทินได้ถูกต้อง ต่างจาก countInclusiveCalendarDays ที่
// นับเป็นจำนวนวันคงที่ (ใช้ไม่ได้กับ cap แบบเดือนเพราะแต่ละเดือนยาวไม่เท่ากัน)
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

// Function ตรวจว่า time_from/time_to ต้องมี date คู่กันเสมอ (date หรือ date_from/date_to แล้วแต่กรณี)
// และถ้าเป็นวันเดียวกัน time_to ต้องไม่น้อยกว่า time_from
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

const optionalTrimmedString = z.preprocess(
  emptyStringToUndefined,
  z.string().trim().optional()
);

// Format field optional ที่ยอมรับ null หรือ empty string เป็นไม่ระบุ
const nullableOptionalTrimmedString = z.preprocess(
  (value) => (value === "" || value === null ? undefined : value),
  z.string().trim().optional()
);

// Format field ที่แยก "ไม่ระบุ" (undefined — ไม่แก้ค่าเดิม) ออกจาก "ระบุเป็น null" (ล้างค่าเดิมจริง)
// ต่างจาก nullableOptionalTrimmedString ข้างบนที่รวม null กับ empty string เป็น undefined ทั้งคู่
// (ไม่มีทางล้างค่าได้เลย) — ใช้กับ field ที่ Frontend ต้องส่ง null มาล้างค่าที่เคยบันทึกไว้ได้จริง เช่น
// email/phone ของ Admin Profile เอง empty string ("") ยังคงถือเป็น "ไม่ระบุ" เหมือนเดิม ไม่เปลี่ยน
// behavior เดิมของ field ที่ยังไม่ต้องการล้างค่าแบบนี้
const clearableTrimmedString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().trim().nullable().optional()
);

// Format client id ของ Gate แบบ optional สำหรับ body สร้างใหม่ ถ้าว่างให้ระบบสร้างให้
const optionalGateClientIdString = z.preprocess(
  emptyStringToUndefined,
  gateClientIdString.optional()
);

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

const optionalPageNumber = z.preprocess(
  emptyStringToUndefined,
  z.coerce.number().int().min(1).optional()
);

const optionalLimitNumber = z.preprocess(
  emptyStringToUndefined,
  z.coerce.number().int().min(1).max(100).optional()
);

const pageQuerySchema = z.preprocess(
  emptyStringToUndefined,
  z.coerce.number().int().min(1).default(1)
);

const limitQuerySchema = z.preprocess(
  emptyStringToUndefined,
  z.coerce.number().int().min(1).max(100).default(DEFAULT_PAGE_LIMIT)
);

/* -------------------------------------- Common Schemas -------------------------------------- */

export const idSchema = z.coerce.number().int().positive();

/* -------------------------------------- Auth Schemas -------------------------------------- */

export const loginBodySchema = z.object({
  username: trimmedString,
  password: trimmedString,
  device_id: optionalTrimmedString,
  device_name: optionalTrimmedString,
  fcm_token: optionalTrimmedString,
  platform: pushPlatformSchema,
});

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

export const refreshBodySchema = z.object({
  refresh_token: trimmedString,
});

export const changeOwnPasswordBodySchema = z.object({
  current_password: trimmedString,
  new_password: newPasswordSchema,
});

export const updateOwnLangBodySchema = z.object({
  lang: accountLangSchema,
});

export const updateOwnProfileBodySchema = z.object({
  full_name: optionalTrimmedString,
  // ยอมรับ null เพื่อล้างค่าเดิมได้จริง (ต่างจาก full_name ที่ต้องไม่ว่างเสมอ) — undefined = ไม่แก้
  email: clearableTrimmedString,
  phone: clearableTrimmedString,
});

/* -------------------------------------- User Schemas -------------------------------------- */

const updateProfileInputSchema = z.object({
  nationality: optionalWorkerNationalitySchema,
  work_start_date: optionalDateString,
  shirt_type: optionalWorkerShirtTypeSchema,
  shirt_number: optionalTrimmedString,
});

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

    // Optional — Gate Vendor ยังไม่ส่งมาปัจจุบัน (ระบบ Fallback ไปใช้ Hash ทั้ง Body แบบเดิม) เมื่อ Vendor
    // อัปเดตฝั่งเขาให้ส่ง Field นี้มาด้วยค่าคงที่ตัวเดียวกันทุกครั้งที่ Retry คำขอเดิม (ไม่สร้างใหม่ทุก
    // ครั้งเหมือน TicketCreatedAt) ระบบจะใช้ค่านี้เป็น Idempotency Key แทน Hash ทั้ง Body ทันที กัน Retry
    // ที่ Payload มี Field ผันแปร (เช่น Timestamp สร้างใหม่) ถูกมองว่าเป็นคำขอใหม่ทั้งที่ตั้งใจ Retry
    // (ดู BUG-020)
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

export const driverQrSessionBodySchema = z.object({
  qr_token: trimmedString,
  // UUID ประจำ browser/เครื่องที่ Driver Web สร้างครั้งเดียวแล้วเก็บไว้ ใช้นับ active device ต่อรถและ rotate session
  device_id: trimmedString,
});

// Schema body สำหรับ worker scan barcode เข้า Business Ticket
export const workerCheckInBarcodeBodySchema = z.object({
  ticket_no: trimmedString,
});

// Format จำนวนสินค้าที่ยืนยันตอนส่งยอด (Worker/Admin) — ห้าม coerce null/ค่าว่าง/boolean เป็น 0 แบบเงียบๆ
// (Booth จะถูกคิดเงิน 0 บาททั้งที่ client ไม่ได้ส่งจำนวนมาจริง) และจำกัดเพดานตามคอลัมน์ Decimal(12,2)
// กัน overflow กลายเป็น 500 ตอนบันทึก
const MAX_CONFIRMED_QUANTITY = 9_999_999_999.99;
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

// ticket_no ระบุว่าส่งยอดให้ Business Ticket ใบไหน (บูธเดียวกันอาจซ้ำ boothCode กันได้ข้าม
// Business Ticket คนละตลาด จึงต้องระบุให้ชัดเจน ไม่พึ่ง boothCode อย่างเดียว)
export const workerTicketCompleteBodySchema = z.object({
  ticket_no: trimmedString,
  boothCode: trimmedString,
  items: z.array(workerTicketCompleteItemSchema).min(1),
});

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

export const workerEarningsSummaryQuerySchema = z.object({}).strict();

// Format history_status ของ Work History — business group ที่ต่างจาก status เดิม (ดู
// buildHistoryStatusFilter ใน admin-jobs.repository.ts) ALL ไม่ใช่ทุกสถานะในฐานข้อมูล แต่คือ OR ของ
// COMPLETED, CANCELLED และ REJECT_PENDING เท่านั้น
const historyStatusValues = ["ALL", "COMPLETED", "CANCELLED", "REJECT_PENDING"] as const;

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

const vehicleOperationStatusValues = [
  VEHICLE_OPERATION_STATUS.READY_NOW,
  VEHICLE_OPERATION_STATUS.WAIT_UNLOAD,
  VEHICLE_OPERATION_STATUS.WAIT_WORKER,
  VEHICLE_OPERATION_STATUS.WORKING,
  VEHICLE_OPERATION_STATUS.COMPLETED,
  VEHICLE_OPERATION_STATUS.CANCELLED,
  VEHICLE_OPERATION_STATUS.REJECT,
] as const;

export const adminTicketJobOperationsQuerySchema = z
  .object({
    date: optionalDateString,
    date_from: optionalDateString,
    date_to: optionalDateString,
    // Format เวลาเริ่มต้น/สิ้นสุด HH:mm optional ผูกกับ date/date_from และ date/date_to ตามลำดับ —
    // narrow ช่วง createdAt ที่กรองอยู่แล้วให้เป็นเวลาที่ต้องการแทนเต็มวัน (ดู
    // buildBangkokDateSpanRange ใน utils/time.ts)
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

const adminAuditEventsActorTypeValues = [
  ...ADMIN_AUDIT_ACTOR_TYPE_VALUES,
] as const;

// 27.15.1 — quick_filter การ์ดด่วนเดียวที่แทน has_vehicle/has_reason/severity เดิมทั้งหมด ตั้งใจแยก
// จาก actor_type/event_type/search/date_from/date_to (filter จากแถบค้นหา) โดยเด็ดขาด: quick_filter
// ต้องไม่มีผลต่อ Summary เลย มีผลแค่ Data/Pagination เท่านั้น (ดู listAuditEvents ฝั่ง service — คำนวณ
// Summary จาก filter แถบค้นหาก่อน แล้วค่อยใช้ quick_filter กรองต่อ) เลือกได้ทีละ 1 ค่า ไม่ส่งหมายถึง
// ไม่ใช้ตัวกรองด่วนเลย — system/admin ต้องใช้ผ่านนี้ ห้ามใช้ actor_type แทนเพราะ actor_type มีผลต่อ
// Summary ตามที่ออกแบบไว้
const adminAuditQuickFilterValues = [
  "has_vehicle",
  "system",
  "critical",
  "admin",
  "has_reason",
] as const;

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

export const adminCancelBodySchema = z.object({
  reason_code: optionalTrimmedString,
  reason_text: nullableOptionalTrimmedString,
});

// Body ของ Cancel Assignment (ticketNumber + workerCode) เท่านั้น
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

export const adminAssignWorkersBodySchema = z.object({
  worker_codes: z.array(trimmedString).min(1),
  reason_code: trimmedString,
  reason_text: nullableOptionalTrimmedString,
});

const adminOverrideCountItemSchema = z.object({
  productCode: trimmedString,
  packageCode: trimmedString,
  actual_quantity: confirmedQuantitySchema,
});

export const adminOverrideCountBodySchema = z.object({
  reason_code: trimmedString,
  reason_text: nullableOptionalTrimmedString,
  counts: z.array(adminOverrideCountItemSchema).min(1),
});

export const adminVehicleWaitBodySchema = z.object({
  dispatch: z.boolean(),
  reason_code: trimmedString,
  reason_text: nullableOptionalTrimmedString,
});

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

// Format query ของรายงานค่าลงสินค้าแผงค้ารายวัน (Admin) — date_from/date_to บังคับคู่กันเสมอ (ต่างจาก
// adminDailyWorkerIncomeQuerySchema ที่ optional) และช่วงวันที่ห้ามเกิน 31 วัน ตาม docs/backend-missing-apis-spec V8.md ข้อ 28.4
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

// จำนวนเดือนสูงสุดที่ยอมให้เลือกช่วงวันที่ของรายงานค่าลงสินค้าแผงค้ารายเดือน — ตั้งไว้กว้างๆ กัน query
// หนักเกินไป ปรับได้ทีหลังถ้าจำเป็น (ไม่ผูกกับ business rule ตายตัว)
export const MONTHLY_STALL_FEE_MAX_RANGE_MONTHS = 6;

// Format query ของรายงานค่าลงสินค้าแผงค้ารายเดือน (Admin) — date_from/date_to บังคับคู่กันเสมอ
// รองรับช่วงข้ามเดือน/ปีได้ตามปกติ (ไม่บังคับเดือนเดียว ต่างจาก daily-stall-fees) แค่ห้ามเกิน
// MONTHLY_STALL_FEE_MAX_RANGE_MONTHS เดือนนับจาก date_from แบบปฏิทินจริง ไม่ใช่นับวันคงที่
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

export const adminExtendScanDeadlineBodySchema = z.object({
  minutes: z.coerce.number().int().positive().max(240),
  worker_codes: z.array(trimmedString).min(1).optional(),
  reason_code: trimmedString,
  reason_text: nullableOptionalTrimmedString,
});

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

export const createGateClientBodySchema = z.object({
  client_id: optionalGateClientIdString,
  name: trimmedString,
  status: defaultGateClientStatusSchema,
});

export const updateGateClientBodySchema = z
  .object({
    name: optionalTrimmedString,
    status: optionalGateClientStatusSchema,
  })
  .refine((value) => value.name !== undefined || value.status !== undefined, {
    message: "At least one field is required.",
  });

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
    // ต้องไม่สั้นกว่ากะที่ยาวที่สุด (กะข้ามคืนยาวได้เกือบ 24 ชม.) ไม่งั้นตัวนับการพักหมดอายุกลางกะ พักเกิน limit ได้
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

export const createMobileAppVersionBodySchema = z
  .object({
    version: trimmedString,
    build_number: buildNumberSchema,
    release_at: optionalDateTimeString,
    android_download_url: optionalHttpsUrlString,
    ios_download_url: optionalHttpsUrlString,
    release_message: optionalTrimmedString,
    release_notes: optionalTrimmedString,
    // มีค่า = บังคับ Update ตั้งแต่เวลานี้ (ทั้ง Activate Version และส่ง FCM บังคับอัตโนมัติ)
    // ไม่มีค่า = Version มีผลทันทีแบบ Optional ไม่บังคับ
    force_update_at: optionalDateTimeString,
    // null/ไม่ส่งมา = ส่ง FCM แจ้งเตือนล่วงหน้าทันที, มีค่า = ตั้งเวลาส่งผ่าน BullMQ
    release_notification_at: optionalDateTimeString,
  })
  .superRefine(refineReleaseNotificationTiming);

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

export const mobileAppVersionCheckQuerySchema = z.object({
  platform: z.enum(["android", "ios"]).optional(),
  version: optionalTrimmedString,
  build_number: z.coerce.number().int().min(0).optional(),
});

export const updateAccountPermissionsBodySchema = z.object({
  permission_level: z.enum(ADMIN_PERMISSION_LEVELS),
  status: optionalActiveStatusSchema,
  permissions: z
    .array(z.enum(ADMIN_PERMISSIONS))
    .default([]),
});

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

const optionalUserListShiftSchema = z.preprocess(
  emptyStringToUndefined,
  z.enum(USER_LIST_SHIFTS).optional()
);

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

// page/limit ไม่มี default ต่างจาก paginationQuerySchema — ไม่ส่งมาเลยต้องหมายถึง "ดึงทั้งหมดเหมือนเดิม" ไม่ใช่ page 1 โดยปริยาย
export const optionalPaginationQuerySchema = z.object({
  page: z.preprocess(emptyStringToUndefined, z.coerce.number().int().min(1).optional()),
  limit: z.preprocess(emptyStringToUndefined, z.coerce.number().int().min(1).max(100).optional()),
});

/* -------------------------------------- Token Schemas -------------------------------------- */

const tokenTimestampsSchema = {
  iat: z.number().optional(),
  exp: z.number().optional(),
};

export const accessTokenPayloadSchema = z.object({
  account_id: z.number().int().positive(),
  role: z.enum(ACCOUNT_ROLES),
  permission_level: optionalTrimmedString.nullable(),
  permissions: z.array(z.enum(ADMIN_PERMISSIONS)).optional(),
  session_id: z.number().int().positive(),
  token_type: z.literal("access"),
  ...tokenTimestampsSchema,
});

export const refreshTokenPayloadSchema = z.object({
  account_id: z.number().int().positive(),
  role: z.enum(ACCOUNT_ROLES),
  session_id: z.number().int().positive(),
  token_type: z.literal("refresh"),
  ...tokenTimestampsSchema,
});

export const loginChallengeTokenPayloadSchema = z.object({
  account_id: z.number().int().positive(),
  role: z.enum(ACCOUNT_ROLES),
  old_session_id: z.number().int().positive(),
  new_device_id: trimmedString,
  token_type: z.literal("login_challenge"),
  ...tokenTimestampsSchema,
});
