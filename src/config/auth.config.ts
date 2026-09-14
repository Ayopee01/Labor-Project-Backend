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

// Config ค่า default ของ token และ session เมื่อไม่ได้กำหนดผ่าน env
export const AUTH_DEFAULTS = {
  accessTokenExpiresIn: "15m",
  accessTokenExpiresInSeconds: 15 * TIME_UNIT_SECONDS.m,
  refreshTokenExpiresIn: "7d",
  loginChallengeExpiresIn: "5m",
  sessionExpiresInMilliseconds: 7 * TIME_UNIT_SECONDS.d * 1000,
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
