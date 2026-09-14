import assert from "node:assert/strict";
import test from "node:test";

// ต้องตั้งค่า Env ก่อน Import jwt.ts เสมอ เพราะ TOKEN_CONFIG อ่าน process.env ครั้งเดียวตอน Module Load
// ตั้งใจใช้ JWT_ACCESS_SECRET เป็นค่า Placeholder ที่รู้จัก (weak) เพื่อทดสอบว่า signAccessToken ปฏิเสธ
// ค่านี้จริง — ส่วน Secret ตัวอื่นตั้งเป็นค่าที่แข็งแรงพอ (32+ ตัวอักษร) เพื่อแยกให้ชัดว่า Error ที่ได้มา
// จาก JWT_ACCESS_SECRET เท่านั้น ไม่ใช่จากตัวอื่น
process.env.JWT_ACCESS_SECRET = "change-this-access-secret";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-min-32-chars";
process.env.JWT_LOGIN_CHALLENGE_SECRET = "test-login-challenge-secret-min-32";
process.env.REFRESH_TOKEN_HASH_SECRET = "test-refresh-hash-secret-min-32-ok";

/* eslint-disable @typescript-eslint/no-require-imports */
const { signAccessToken, signRefreshToken } = require("../../../src/utils/jwt");

const SAMPLE_PAYLOAD = { account_id: 1, role: "admin", session_id: 1 };

test("signAccessToken rejects a known weak/placeholder JWT secret", () => {
  assert.throws(() => {
    signAccessToken(SAMPLE_PAYLOAD);
  }, /strong/);
});

test("signRefreshToken still works when only a different token type's secret is weak", () => {
  assert.doesNotThrow(() => {
    signRefreshToken(SAMPLE_PAYLOAD);
  });
});
