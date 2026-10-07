// Import Library
import assert from "node:assert/strict";
import test from "node:test";

// ตั้ง env ก่อน import jwt.ts ให้ access secret เป็นค่า placeholder (อ่อน) ส่วนตัวอื่นแข็งแรง
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
    signRefreshToken(SAMPLE_PAYLOAD, { expiresIn: "7d" });
  });
});
