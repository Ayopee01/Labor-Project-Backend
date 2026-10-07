// Import Library
import jwt, { type SignOptions } from "jsonwebtoken";
import type { ZodType } from "zod";
// Import Config
import { AUTH_DEFAULTS, getAccessTokenRefreshThresholdSeconds } from "../config/auth.config";
// Import Types
import type { AccessTokenPayload, LoginChallengeTokenPayload, RefreshTokenPayload, TokenConfig, TokenPayloadByType, TokenSignOptions, TokenType } from "../types/auth.type";
// Import Validation
import { parseWithSchema } from "../validation/parser";
import { accessTokenPayloadSchema, loginChallengeTokenPayloadSchema, refreshTokenPayloadSchema } from "../validation/schemas";
// Import Utils
import ApiError from "./api-error";

/* -------------------------------------- Config -------------------------------------- */

// Config secret, อายุ และ error code ของ token แต่ละชนิด
const TOKEN_CONFIG: Record<TokenType, TokenConfig> = {
  access: {
    secret: process.env.JWT_ACCESS_SECRET,
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || AUTH_DEFAULTS.accessTokenExpiresIn,
    invalidCode: "INVALID_TOKEN",
    expiredCode: "TOKEN_EXPIRED",
  },
  refresh: {
    secret: process.env.JWT_REFRESH_SECRET,
    // ไม่มีอายุ default เพราะแยกตาม role ผู้เรียกต้องส่ง options.expiresIn เสมอ
    invalidCode: "INVALID_REFRESH_TOKEN",
    expiredCode: "TOKEN_EXPIRED",
  },
  login_challenge: {
    secret: process.env.JWT_LOGIN_CHALLENGE_SECRET,
    expiresIn: process.env.JWT_LOGIN_CHALLENGE_EXPIRES_IN || AUTH_DEFAULTS.loginChallengeExpiresIn,
    invalidCode: "INVALID_LOGIN_CHALLENGE",
    expiredCode: "LOGIN_CHALLENGE_EXPIRED",
  },
};

// Config ค่า secret ที่ห้ามใช้ (ค่าง่ายเกินไป หรือ placeholder จาก .env.example)
const WEAK_JWT_SECRET_VALUES = new Set([
  "secret",
  "password",
  "change-me",
  "change-this-access-secret",
  "change-this-refresh-secret",
  "change-this-login-challenge-secret",
  "CHANGE_ME_GENERATE_WITH_OPENSSL_RAND_BASE64_32_ACCESS",
  "CHANGE_ME_GENERATE_WITH_OPENSSL_RAND_BASE64_32_REFRESH",
  "CHANGE_ME_GENERATE_WITH_OPENSSL_RAND_BASE64_32_LOGIN_CHALLENGE",
]);

// Config schema ที่ใช้ validate payload ของ token แต่ละชนิด
const TOKEN_PAYLOAD_SCHEMAS: {
  [TTokenType in TokenType]: ZodType<TokenPayloadByType[TTokenType]>;
} = {
  access: accessTokenPayloadSchema,
  refresh: refreshTokenPayloadSchema,
  login_challenge: loginChallengeTokenPayloadSchema,
};

/* -------------------------------------- Functions -------------------------------------- */

// Function ดึง config ของ token ชนิดนั้น และตรวจว่า secret ถูกตั้งและแข็งแรงพอ
function getTokenConfig(tokenType: TokenType): TokenConfig & { secret: string } {
  const config = TOKEN_CONFIG[tokenType];

  if (!config) {
    throw new TypeError(`Unsupported token type: ${tokenType}`);
  }

  if (!config.secret) {
    throw new Error(`${tokenType} token secret must be configured.`);
  }

  if (config.secret.length < 32 || WEAK_JWT_SECRET_VALUES.has(config.secret)) {
    throw new Error(
      `${tokenType} token secret must be a strong value (at least 32 characters, not a default placeholder).`
    );
  }

  return config as TokenConfig & { secret: string };
}

// Function เซ็น JWT ตามชนิด token ที่ระบุ
function signTypedToken<TTokenType extends TokenType>(
  payload: Omit<TokenPayloadByType[TTokenType], "token_type" | "iat" | "exp">,
  tokenType: TTokenType,
  options: TokenSignOptions = {}
): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("JWT payload must be an object.");
  }

  const config = getTokenConfig(tokenType);
  const expiresIn = options.expiresIn ?? config.expiresIn;

  if (expiresIn === undefined) {
    throw new TypeError(`${tokenType} token requires an expiresIn (no default configured for this type).`);
  }

  return jwt.sign(
    {
      ...payload,
      token_type: tokenType,
    },
    config.secret,
    {
      algorithm: "HS256",
      expiresIn: expiresIn as SignOptions["expiresIn"],
    }
  );
}

// Function ตรวจ JWT และ validate payload ตามชนิด token ที่ระบุ
function verifyTypedToken<TTokenType extends TokenType>(
  token: string,
  tokenType: TTokenType
): TokenPayloadByType[TTokenType] {
  const config = getTokenConfig(tokenType);

  if (!token || typeof token !== "string") {
    throw new ApiError(401, config.invalidCode, "Invalid token.");
  }

  try {
    const payload = jwt.verify(token, config.secret, {
      algorithms: ["HS256"],
    });

    const parseOptions = {
      statusCode: 401,
      code: config.invalidCode,
      message: "Invalid token.",
    };

    return parseWithSchema<TokenPayloadByType[TTokenType]>(
      TOKEN_PAYLOAD_SCHEMAS[tokenType],
      payload,
      parseOptions
    );
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    if (error instanceof Error && error.name === "TokenExpiredError") {
      throw new ApiError(401, config.expiredCode, "Token expired.");
    }

    throw new ApiError(401, config.invalidCode, "Invalid token.");
  }
}

// Function เซ็น access token
export const signAccessToken = (
  payload: Omit<AccessTokenPayload, "token_type" | "iat" | "exp">,
  options: TokenSignOptions = {}
): string => signTypedToken(payload, "access", options);

// Function เซ็น refresh token
export const signRefreshToken = (
  payload: Omit<RefreshTokenPayload, "token_type" | "iat" | "exp">,
  options: TokenSignOptions = {}
): string => signTypedToken(payload, "refresh", options);

// Function เซ็น login challenge token
export const signLoginChallengeToken = (
  payload: Omit<LoginChallengeTokenPayload, "token_type" | "iat" | "exp">,
  options: TokenSignOptions = {}
): string => signTypedToken(payload, "login_challenge", options);

// Function ตรวจ access token
export const verifyAccessToken = (token: string): AccessTokenPayload =>
  verifyTypedToken(token, "access");

// Function ตรวจ refresh token
export const verifyRefreshToken = (token: string): RefreshTokenPayload =>
  verifyTypedToken(token, "refresh");

// Function ตรวจ login challenge token
export const verifyLoginChallengeToken = (
  token: string
): LoginChallengeTokenPayload => verifyTypedToken(token, "login_challenge");

// Function เช็คว่า access token ใกล้หมดอายุตาม threshold หรือยัง (ใช้เตือน client ให้ไป /refresh เอง)
export function isAccessTokenNearingExpiry(exp: number | undefined): boolean {
  if (typeof exp !== "number") {
    return false;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const thresholdSeconds = getAccessTokenRefreshThresholdSeconds();

  return exp - nowSeconds <= thresholdSeconds;
}
