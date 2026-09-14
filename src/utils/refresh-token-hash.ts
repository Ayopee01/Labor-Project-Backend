// Import Library
import crypto from "node:crypto";

/* -------------------------------------- Config -------------------------------------- */

const REFRESH_TOKEN_HASH_CONFIG = {
  secret: process.env.REFRESH_TOKEN_HASH_SECRET,
  algorithm: "sha256" as const,
  prefix: "hmac-sha256",
};

// ค่า Secret ที่ห้ามใช้เด็ดขาด (ค่า Default ง่ายเกินไป หรือ Placeholder จาก .env.example ที่ยาวพอผ่าน
// เกณฑ์ความยาวแต่ยังเป็นค่าเดิมที่ไม่ได้เปลี่ยน)
const WEAK_REFRESH_TOKEN_HASH_SECRET_VALUES = new Set([
  "secret",
  "password",
  "change-me",
  "change-this-refresh-token-hash-secret",
  "CHANGE_ME_GENERATE_WITH_OPENSSL_RAND_BASE64_32_REFRESH_HASH",
]);

/* -------------------------------------- Functions -------------------------------------- */

// Function ดึง refresh token hash config สำหรับ helper กลาง
function getRefreshTokenHashConfig(): typeof REFRESH_TOKEN_HASH_CONFIG & {
  secret: string;
} {
  if (!REFRESH_TOKEN_HASH_CONFIG.secret) {
    throw new Error("Refresh token hash secret must be configured.");
  }

  if (
    REFRESH_TOKEN_HASH_CONFIG.secret.length < 32 ||
    WEAK_REFRESH_TOKEN_HASH_SECRET_VALUES.has(REFRESH_TOKEN_HASH_CONFIG.secret)
  ) {
    throw new Error(
      "Refresh token hash secret must be a strong value (at least 32 characters, not a default placeholder)."
    );
  }

  return REFRESH_TOKEN_HASH_CONFIG as typeof REFRESH_TOKEN_HASH_CONFIG & {
    secret: string;
  };
}

// Function hash refresh token สำหรับ helper กลาง
export function hashRefreshToken(refreshToken: string): string {
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new TypeError("Refresh token must be a non-empty string.");
  }

  const config = getRefreshTokenHashConfig();

  const digest = crypto
    .createHmac(config.algorithm, config.secret)
    .update(refreshToken)
    .digest("base64url");

  return `${config.prefix}$${digest}`;
}

// Function refresh token hashes match สำหรับ helper กลาง
export function refreshTokenHashesMatch(
  candidateHash: string | null | undefined,
  storedHash: string | null | undefined
): boolean {
  if (typeof candidateHash !== "string" || typeof storedHash !== "string") {
    return false;
  }

  const candidateBuffer = Buffer.from(candidateHash);
  const storedBuffer = Buffer.from(storedHash);

  return (
    candidateBuffer.length === storedBuffer.length &&
    crypto.timingSafeEqual(candidateBuffer, storedBuffer)
  );
}
