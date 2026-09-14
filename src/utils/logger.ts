import { pinoLogger } from "../config/logger";

type LogLevel = "info" | "warn" | "error";

type LogContext = Record<string, unknown>;

const REDACTED = "[REDACTED]";
const SECRET_KEY_PATTERN =
  /(authorization|password|secret|token|database_url|redis_url|private_key|credential)/i;
const SECRET_ENV_NAME_PATTERN =
  /(authorization|password|secret|token|database_url|redis_url|private_key|credential)/i;
const URL_CREDENTIAL_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)([^:@/\s]+):([^@/\s]+)@/gi;

function sanitizeString(value: string): string {
  let sanitized = value.replace(URL_CREDENTIAL_PATTERN, `$1${REDACTED}:${REDACTED}@`);

  for (const [key, secretValue] of Object.entries(process.env)) {
    if (
      SECRET_ENV_NAME_PATTERN.test(key) &&
      typeof secretValue === "string" &&
      secretValue.length >= 8
    ) {
      sanitized = sanitized.split(secretValue).join(REDACTED);
    }
  }

  return sanitized;
}

function redact(value: unknown): unknown {
  if (value instanceof Error) {
    // Stack Trace เก็บไว้เสมอ (Sanitize ผ่าน sanitizeString เหมือน message) — เดิมตัดทิ้งทุกครั้งทำให้
    // ไม่มี Stack Trace เหลืออยู่ที่ไหนเลยใน Log ปกติ (Sentry เก็บแยกจาก Error ดิบต่างหาก) ถ้ายังไม่ได้
    // ตั้ง SENTRY_DSN การ Debug 500 ใน Production จะเหลือแค่ชื่อ+ข้อความ Error ไม่พอสืบสาเหตุ (ดู BUG-013)
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

function write(level: LogLevel, message: string, context: LogContext = {}): void {
  pinoLogger[level](redact(context) as LogContext, message);
}

export const logger = {
  info: (message: string, context?: LogContext) => write("info", message, context),
  warn: (message: string, context?: LogContext) => write("warn", message, context),
  error: (message: string, context?: LogContext) => write("error", message, context),
  redact,
};
