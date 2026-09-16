import assert from "node:assert/strict";
import { before, test } from "node:test";

/* -------------------------------------- Test Env -------------------------------------- */

// ต้องยาวอย่างน้อย 32 ตัวอักษรเพื่อผ่านเกณฑ์ความแข็งแรงของ Secret ที่ jwt.ts เช็คตอน module load
// (notifications.service.ts ไม่ได้ใช้ jwt โดยตรง แต่ต้อง set ไว้เผื่อ import chain อื่นดึง jwt.ts เข้ามาด้วย)
process.env.JWT_ACCESS_SECRET ??= "test-access-secret-min-32-charss";
process.env.JWT_REFRESH_SECRET ??= "test-refresh-secret-min-32-chars";
process.env.JWT_LOGIN_CHALLENGE_SECRET ??= "test-login-challenge-secret-min-32";
process.env.REFRESH_TOKEN_HASH_SECRET ??= "test-refresh-hash-secret-min-32-ok";

/* -------------------------------------- Helpers -------------------------------------- */

// Function ตั้งค่า env ชั่วคราวสำหรับ 1 test แล้วคืนค่าเดิมให้เสมอแม้ assertion จะ throw ระหว่างทาง
function withEnv(overrides: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const previous: Record<string, string | undefined> = {};

  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return run().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Function สร้าง fake Express Response ขั้นต่ำที่ subscribeAdminEvents ต้องใช้ (setHeader/write/on/req.on)
// โดยไม่ต้องเปิด HTTP server จริง — เก็บทุก chunk ที่ถูก write ไว้ให้ตรวจสอบได้ และคืน close() สำหรับ
// เรียก cleanup listener ("close") ที่ service ผูกไว้ตอนจบ test กัน heartbeat/timer ค้าง
function createFakeSseResponse(): {
  response: { setHeader: () => void; flushHeaders: () => void; write: (chunk: string) => boolean; on: (event: string, cb: () => void) => void; req: { on: (event: string, cb: () => void) => void } };
  written: string[];
  close: () => void;
} {
  const written: string[] = [];
  const reqListeners: Record<string, () => void> = {};
  const resListeners: Record<string, () => void> = {};

  const response = {
    setHeader: () => undefined,
    flushHeaders: () => undefined,
    write: (chunk: string) => {
      written.push(chunk);
      return true;
    },
    on: (event: string, cb: () => void) => {
      resListeners[event] = cb;
    },
    req: {
      on: (event: string, cb: () => void) => {
        reqListeners[event] = cb;
      },
    },
  };

  return {
    response,
    written,
    close: () => reqListeners.close?.(),
  };
}

/* -------------------------------------- Test Modules -------------------------------------- */

let notificationsService: typeof import("../../../src/services/notifications.service");

before(async () => {
  notificationsService = await import("../../../src/services/notifications.service");
});

/* -------------------------------------- Test -------------------------------------- */

test("subscribeAdminEvents schedules a TOKEN_NEARING_EXPIRY SSE event before the connecting access token expires, mirroring the worker socket reminder", async () => {
  await withEnv({ ACCESS_TOKEN_REFRESH_THRESHOLD: "1s" }, async () => {
    const { response, written, close } = createFakeSseResponse();
    const nowSeconds = Math.floor(Date.now() / 1000);

    notificationsService.subscribeAdminEvents(response as any, {
      account_id: 1,
      role: "admin",
      session_id: 1,
      token_type: "access",
      exp: nowSeconds + 3,
    } as any);

    try {
      assert.ok(
        written.some((chunk) => chunk.includes("event: connected")),
        "subscribeAdminEvents must write the initial connected event."
      );
      assert.ok(
        !written.some((chunk) => chunk.includes("event: TOKEN_NEARING_EXPIRY")),
        "TOKEN_NEARING_EXPIRY must not fire immediately while the token is still fresh."
      );

      await sleep(2200);

      assert.ok(
        written.some((chunk) => chunk.includes("event: TOKEN_NEARING_EXPIRY")),
        "TOKEN_NEARING_EXPIRY must fire once the connecting token is within the refresh threshold."
      );
    } finally {
      close();
    }
  });
});

test("subscribeAdminEvents does not schedule a reminder when the auth payload carries no exp", async () => {
  const { response, written, close } = createFakeSseResponse();

  notificationsService.subscribeAdminEvents(response as any, {
    account_id: 1,
    role: "admin",
    session_id: 1,
    token_type: "access",
  } as any);

  try {
    await sleep(50);
    assert.ok(!written.some((chunk) => chunk.includes("TOKEN_NEARING_EXPIRY")));
  } finally {
    close();
  }
});
