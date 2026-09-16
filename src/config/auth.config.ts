/* -------------------------------------- Config -------------------------------------- */

// Config หน่วยเวลาที่รองรับสำหรับแปลงค่าอายุ token จาก env
const TIME_UNIT_SECONDS = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
} as const;

// Type หน่วยเวลาที่ระบบ auth รองรับ
type DurationUnit = keyof typeof TIME_UNIT_SECONDS;

// Config รูปแบบ duration เช่น 15m, 7d หรือเลขวินาที
const DURATION_PATTERN = /^(\d+)([smhd])?$/;

// Config ค่า default ของ token เมื่อไม่ได้กำหนดผ่าน env
export const AUTH_DEFAULTS = {
  accessTokenExpiresIn: "15m",
  accessTokenExpiresInSeconds: 15 * TIME_UNIT_SECONDS.m,
  loginChallengeExpiresIn: "5m",
  // Refresh token อายุนี้ใช้เป็น single source of truth ทั้งอายุ JWT (exp claim) และอายุ session ใน DB (expires_at) —
  // Worker อายุยาวกว่า admin เพราะใช้งานเป็น mobile app ประจำวัน ไม่ได้ถือสิทธิ์สูงเท่า admin ที่ควร re-authenticate ถี่กว่า
  workerRefreshExpiresInSeconds: 7 * TIME_UNIT_SECONDS.d,
  adminRefreshExpiresInSeconds: 24 * TIME_UNIT_SECONDS.h,
  // เวลาก่อน access token จะหมดอายุที่เริ่มส่งสัญญาณเตือน (response header / socket event) ให้ client ไป /refresh เอง
  accessTokenRefreshThresholdSeconds: 2 * TIME_UNIT_SECONDS.m,
} as const;

/* -------------------------------------- Functions -------------------------------------- */

// Function แปลงค่า duration เป็นวินาที และใช้ fallback เมื่อรูปแบบไม่ถูกต้อง
function parseDurationSeconds(
  value: string | number | undefined,
  fallbackSeconds: number
): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }

  if (typeof value !== "string") {
    return fallbackSeconds;
  }

  const match = value.trim().match(DURATION_PATTERN);

  if (!match) {
    return fallbackSeconds;
  }

  const durationAmount = Number(match[1]);
  const durationUnit = (match[2] || "s") as DurationUnit;

  return durationAmount * TIME_UNIT_SECONDS[durationUnit];
}

// Function อ่านอายุ access token จาก env เป็นวินาทีสำหรับ response และ logic auth
export function getAccessTokenExpiresInSeconds(): number {
  return parseDurationSeconds(
    process.env.JWT_ACCESS_EXPIRES_IN,
    AUTH_DEFAULTS.accessTokenExpiresInSeconds
  );
}

// Function อ่านอายุ refresh token ของ worker จาก env เป็นวินาที — ใช้ทั้งเซ็น JWT (exp) และตั้ง expires_at
// ของ session ใน DB จากค่าเดียวกัน กันไม่ให้สอง config หลุด sync กันแบบที่เคยเป็นตอนแยก session cap ไว้ต่างหาก
export function getWorkerRefreshExpiresInSeconds(): number {
  return parseDurationSeconds(
    process.env.JWT_REFRESH_EXPIRES_IN_WORKER,
    AUTH_DEFAULTS.workerRefreshExpiresInSeconds
  );
}

// Function อ่านอายุ refresh token ของ admin จาก env เป็นวินาที — ใช้ทั้งเซ็น JWT (exp) และตั้ง expires_at
// ของ session ใน DB จากค่าเดียวกัน
export function getAdminRefreshExpiresInSeconds(): number {
  return parseDurationSeconds(
    process.env.JWT_REFRESH_EXPIRES_IN_ADMIN,
    AUTH_DEFAULTS.adminRefreshExpiresInSeconds
  );
}

// Function อ่าน threshold ก่อน access token หมดอายุที่จะเริ่มส่งสัญญาณเตือนให้ client ไป /refresh เอง (ไม่ใช่การเซ็น
// token ใหม่ให้ตรงๆ) — validate ว่าต้องน้อยกว่าอายุ access token จริงเสมอ กันตั้งค่าผิดจนสัญญาณเตือนทำงานทุก request
export function getAccessTokenRefreshThresholdSeconds(): number {
  const thresholdSeconds = parseDurationSeconds(
    process.env.ACCESS_TOKEN_REFRESH_THRESHOLD,
    AUTH_DEFAULTS.accessTokenRefreshThresholdSeconds
  );
  const accessTokenSeconds = getAccessTokenExpiresInSeconds();

  if (thresholdSeconds <= 0 || thresholdSeconds >= accessTokenSeconds) {
    throw new Error(
      `ACCESS_TOKEN_REFRESH_THRESHOLD (${thresholdSeconds}s) must be greater than 0 and less than the access token lifetime (${accessTokenSeconds}s).`
    );
  }

  return thresholdSeconds;
}
