// Import Config
import { pinoLogger } from "../config/logger";

/* -------------------------------------- Types -------------------------------------- */

// Type ระดับ log ที่รองรับ
type LogLevel = "info" | "warn" | "error";

// Type ข้อมูลเสริมที่แนบไปกับ log
type LogContext = Record<string, unknown>;

/* -------------------------------------- Config -------------------------------------- */

// Config ข้อความแทนค่าที่ถูกปิดบัง และ pattern ของ key/env/URL ที่ต้องปิดบัง
const REDACTED = "[REDACTED]";
const SECRET_KEY_PATTERN =
  /(authorization|password|secret|token|database_url|redis_url|private_key|credential)/i;
const SECRET_ENV_NAME_PATTERN =
  /(authorization|password|secret|token|database_url|redis_url|private_key|credential)/i;
const URL_CREDENTIAL_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)([^:@/\s]+):([^@/\s]+)@/gi;

/* -------------------------------------- Functions -------------------------------------- */

// Function ปิดบัง credential ใน URL และค่า secret จาก env ที่ปนอยู่ในข้อความ
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

// Function เขียน log ผ่าน pino หลังปิดบังค่า secret แล้ว
function write(level: LogLevel, message: string, context: LogContext = {}): void {
  pinoLogger[level](redact(context) as LogContext, message);
}

// Config logger กลางของระบบ
export const logger = {
  info: (message: string, context?: LogContext) => write("info", message, context),
  warn: (message: string, context?: LogContext) => write("warn", message, context),
  error: (message: string, context?: LogContext) => write("error", message, context),
  redact,
};
