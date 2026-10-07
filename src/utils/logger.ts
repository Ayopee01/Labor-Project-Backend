// Import Config
import { pinoLogger } from "../config/logger";
import { Sentry } from "../config/sentry";
// Import Utils
import { getLogContext } from "./log-context";

/* -------------------------------------- Types -------------------------------------- */

// Type ระดับ log ที่รองรับ
type LogLevel = "info" | "warn" | "error";

// Type ข้อมูลเสริมที่แนบไปกับ log
type LogContext = Record<string, unknown>;

// Type ตัวเลือกของ log (reportToSentry = false ใช้กับ log ที่มี event อื่นส่ง Sentry แล้ว)
type LogOptions = { reportToSentry?: boolean };

/* -------------------------------------- Config -------------------------------------- */

// Config ข้อความแทนค่าที่ถูกปิดบัง และ pattern ของ key/env/URL ที่ต้องปิดบัง
const REDACTED = "[REDACTED]";
const SECRET_KEY_PATTERN =
  /(authorization|password|secret|token|database_url|redis_url|private_key|credential)/i;
const SECRET_ENV_NAME_PATTERN =
  /(authorization|password|secret|token|database_url|redis_url|private_key|credential)/i;
const URL_CREDENTIAL_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)([^:@/\s]+):([^@/\s]+)@/gi;

// Config เพดานส่ง Sentry ต่อชนิด error (ข้อความ log + ชนิด error) ต่อช่วงเวลา และจำนวน key สูงสุดที่จำไว้
const SENTRY_REPORT_WINDOW_MS = 60_000;
const SENTRY_REPORTS_PER_WINDOW = 5;
const SENTRY_REPORT_MAX_KEYS = 500;
const sentryReportWindows = new Map<string, { windowStartedAt: number; reported: number; suppressed: number }>();

// Config ค่า secret จาก env ที่จำไว้ตั้งแต่ log ครั้งแรก (env ไม่เปลี่ยนระหว่างรัน ไม่ต้องวน process.env ทุก string)
let secretEnvValues: string[] | null = null;

/* -------------------------------------- Functions -------------------------------------- */

// Function ดึงค่า secret จาก env ที่ต้องปิดบัง (คำนวณครั้งแรกครั้งเดียว ตอนนั้น dotenv โหลดแล้ว)
function getSecretEnvValues(): string[] {
  if (!secretEnvValues) {
    secretEnvValues = Object.entries(process.env)
      .filter(([key, secretValue]) =>
        SECRET_ENV_NAME_PATTERN.test(key) &&
        typeof secretValue === "string" &&
        secretValue.length >= 8
      )
      .map(([, secretValue]) => secretValue as string);
  }

  return secretEnvValues;
}

// Function ปิดบัง credential ใน URL และค่า secret จาก env ที่ปนอยู่ในข้อความ
function sanitizeString(value: string): string {
  let sanitized = value.replace(URL_CREDENTIAL_PATTERN, `$1${REDACTED}:${REDACTED}@`);

  for (const secretValue of getSecretEnvValues()) {
    sanitized = sanitized.split(secretValue).join(REDACTED);
  }

  return sanitized;
}

// Function ปิดบังค่า secret ใน log context แบบ recursive
function redact(value: unknown): unknown {
  if (value instanceof Error) {
    // เก็บ stack trace ไว้เสมอ (ผ่าน sanitize แล้ว) เพื่อใช้สืบสาเหตุเมื่อไม่มี Sentry
    return {
      name: value.name,
      message: sanitizeString(value.message),
      stack: value.stack ? sanitizeString(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) {
    return value.map(redact);
  }

  if (typeof value === "string") {
    return sanitizeString(value);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(entry),
    ]),
  );
}

// Function แปลงค่าใน context เป็น Sentry tag (array เป็นข้อความคั่นด้วย comma)
function toSentryTag(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return Array.isArray(value) ? value.join(",") : String(value);
}

// Function จำกัดจำนวน event ต่อชนิด error ต่อนาที (กัน error เดียวกันยิงรัวจนหมด quota; server log ยังเก็บครบ) คืนจำนวนที่ถูกข้ามไปก่อนหน้า หรือ null = ข้ามครั้งนี้
function takeSentryReportSlot(key: string, now = Date.now()): number | null {
  const current = sentryReportWindows.get(key);

  if (!current || now - current.windowStartedAt >= SENTRY_REPORT_WINDOW_MS) {
    if (sentryReportWindows.size >= SENTRY_REPORT_MAX_KEYS) {
      sentryReportWindows.clear();
    }

    sentryReportWindows.set(key, { windowStartedAt: now, reported: 1, suppressed: 0 });
    return current?.suppressed ?? 0;
  }

  if (current.reported >= SENTRY_REPORTS_PER_WINDOW) {
    current.suppressed += 1;
    return null;
  }

  current.reported += 1;
  return 0;
}

// Function ส่ง error ไป Sentry พร้อม tag อ้างอิง (TicketNumber/TicketNo/requestId) ไว้ค้นหาและเตือน (ไม่ส่ง body)
function reportToSentry(message: string, context: LogContext): void {
  const { error, body: _body, ...rest } = context;
  const suppressedBefore = takeSentryReportSlot(`${message}|${error instanceof Error ? error.name : ""}`);

  if (suppressedBefore === null) {
    return;
  }

  const tags = Object.fromEntries(
    Object.entries({
      requestId: rest.requestId,
      ticket_number: rest.ticketNumber,
      ticket_no: rest.ticketNo ?? rest.ticketNos,
      ticket_job_id: rest.ticketJobId,
      booth_code: rest.boothCode,
      worker_code: rest.workerCode,
      job_name: rest.jobName,
      client_type: rest.clientType,
      path: rest.path,
      alert_code: rest.alertCode,
    })
      .map(([key, value]) => [key, toSentryTag(value)])
      .filter(([, value]) => value !== undefined)
  ) as Record<string, string>;
  const captureContext = {
    tags,
    extra: {
      logMessage: message,
      ...(suppressedBefore > 0 && { suppressedInPreviousWindow: suppressedBefore }),
      ...(redact(rest) as LogContext),
    },
    user: rest.userId !== undefined ? { id: String(rest.userId) } : undefined,
  };

  if (error !== undefined) {
    Sentry.captureException(error, captureContext);
    return;
  }

  Sentry.captureMessage(message, { ...captureContext, level: "error" });
}

// Function เขียน log ผ่าน pino หลังปิดบังค่า secret แล้ว (รวม context ของ request/job ปัจจุบัน ค่าที่ส่งมาตรงชนะ)
function write(level: LogLevel, message: string, context: LogContext = {}, options: LogOptions = {}): void {
  const merged = { ...getLogContext(), ...context };

  pinoLogger[level](redact(merged) as LogContext, message);

  if (level === "error" && options.reportToSentry !== false) {
    reportToSentry(message, merged);
  }
}

// Config logger กลางของระบบ
export const logger = {
  info: (message: string, context?: LogContext, options?: LogOptions) => write("info", message, context, options),
  warn: (message: string, context?: LogContext, options?: LogOptions) => write("warn", message, context, options),
  error: (message: string, context?: LogContext, options?: LogOptions) => write("error", message, context, options),
  redact,
};
