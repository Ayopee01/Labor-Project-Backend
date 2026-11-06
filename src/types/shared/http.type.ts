// Import Library
import type { HttpBindings } from "@hono/node-server";
import type { Context, MiddlewareHandler } from "hono";
// Import Types
import type { AccessTokenPayload, SessionDto } from "../auth.type";
import type { DriverSessionContext } from "../driver.type";
import type { PublicGateClient } from "./gate-client.type";
// Import Utils
import type { LogContext } from "../../utils/log-context";

/* -------------------------------------- Types -------------------------------------- */

// Type ไฟล์รูปที่ upload middleware อ่านจาก multipart แล้ว
export type UploadedImage = { buffer: Buffer; mimetype: string };

// Type ค่าที่ middleware แนบไว้ใน context ของ request
export type AppVariables = {
  auth?: AccessTokenPayload;
  session?: SessionDto;
  driverSession?: DriverSessionContext;
  gateClient?: PublicGateClient;
  body?: any;
  rawBody?: string;
  requestId?: string;
  logContext?: LogContext;
  errorCode?: string;
  errorDetails?: unknown;
  file?: UploadedImage;
};

// Type environment ของ Hono app (รันบน node:http จึงเข้าถึง incoming/outgoing ได้)
export type AppEnv = { Bindings: HttpBindings; Variables: AppVariables };

// Type context ของ request
export type AppContext = Context<AppEnv>;

// Type middleware ของ app
export type AppMiddleware = MiddlewareHandler<AppEnv>;
