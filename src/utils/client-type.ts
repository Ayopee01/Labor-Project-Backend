import type { Request } from "express";

/* -------------------------------------- Config -------------------------------------- */

// Config client type ที่ระบบรู้จัก — ใช้เป็น log field สำหรับแยก request มาจาก client กลุ่มไหน
export const CLIENT_TYPE = {
  WORKER_APP: "worker_app",
  ADMIN_WEBAPP: "admin_webapp",
  DRIVER_WEBAPP: "driver_webapp",
  GATE: "gate",
  LINE_OA: "line_oa",
  UNKNOWN: "unknown",
} as const;

export type ClientType = (typeof CLIENT_TYPE)[keyof typeof CLIENT_TYPE];

const CLIENT_TYPE_VALUES = new Set<string>(Object.values(CLIENT_TYPE));

// Config path prefix ที่แยก client type ได้ตรงตัวจาก path เดียว ไม่ shared กับ client อื่น
const PATH_PREFIX_CLIENT_TYPE: ReadonlyArray<readonly [string, ClientType]> = [
  ["/api/workers", CLIENT_TYPE.WORKER_APP],
  ["/api/admin", CLIENT_TYPE.ADMIN_WEBAPP],
  ["/api/driver", CLIENT_TYPE.DRIVER_WEBAPP],
  ["/api/gate", CLIENT_TYPE.GATE],
  ["/api/line", CLIENT_TYPE.LINE_OA],
];

// Config แปลง role (จาก req.auth) เป็น client type ใช้เป็นสัญญาณเสริมที่แม่นกว่า header
const ROLE_CLIENT_TYPE: Partial<Record<string, ClientType>> = {
  worker: CLIENT_TYPE.WORKER_APP,
  admin: CLIENT_TYPE.ADMIN_WEBAPP,
};

const CLIENT_TYPE_HEADER = "x-client-type";

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจว่าค่าที่ได้ตรงกับ ClientType ที่รู้จักหรือไม่
function isKnownClientType(value: string): value is ClientType {
  return CLIENT_TYPE_VALUES.has(value);
}

// Function หา client type ของ request — ลำดับ: path prefix ก่อน, ถ้าไม่ตรงใช้ req.auth.role, แล้วค่อย
// fallback ไป header X-Client-Type, สุดท้ายคืน "unknown" ถ้าไม่มีสัญญาณอะไรเลย
export function detectClientType(req: Request): ClientType {
  const path = (req.originalUrl || req.path || "").split("?")[0];

  for (const [prefix, clientType] of PATH_PREFIX_CLIENT_TYPE) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      return clientType;
    }
  }

  const roleClientType = req.auth?.role
    ? ROLE_CLIENT_TYPE[req.auth.role]
    : undefined;

  if (roleClientType) {
    return roleClientType;
  }

  const headerValue = req.header(CLIENT_TYPE_HEADER)?.trim().toLowerCase();

  if (headerValue && isKnownClientType(headerValue)) {
    return headerValue;
  }

  return CLIENT_TYPE.UNKNOWN;
}
