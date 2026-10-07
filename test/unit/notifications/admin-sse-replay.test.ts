// Import Library
import assert from "node:assert/strict";
import { before, test } from "node:test";

/* -------------------------------------- Test Env -------------------------------------- */

process.env.JWT_ACCESS_SECRET ??= "test-access-secret-min-32-charss";
process.env.JWT_REFRESH_SECRET ??= "test-refresh-secret-min-32-chars";
process.env.JWT_LOGIN_CHALLENGE_SECRET ??= "test-login-challenge-secret-min-32";
process.env.REFRESH_TOKEN_HASH_SECRET ??= "test-refresh-hash-secret-min-32-ok";

/* -------------------------------------- Helpers -------------------------------------- */

// Type SSE event ที่ parse จาก chunk ที่เขียนออกไป
type ParsedSseEvent = { id: string | null; event: string; data: Record<string, unknown> };

// Function สร้าง Response ปลอมสำหรับ SSE เก็บ chunk ที่ write และคืน close() ไว้ cleanup
function createFakeSseResponse() {
  const written: string[] = [];
  const reqListeners: Record<string, () => void> = {};
  let ended = false;

  const response = {
    setHeader: () => undefined,
    flushHeaders: () => undefined,
    write: (chunk: string) => {
      written.push(chunk);
      return true;
    },
    on: () => undefined,
    end: () => {
      ended = true;
    },
    req: {
      on: (event: string, cb: () => void) => {
        reqListeners[event] = cb;
      },
    },
  };

  return {
    response,
    close: () => reqListeners.close?.(),
    isEnded: () => ended,
    events: (): ParsedSseEvent[] =>
      written
        .join("")
        .split("\n\n")
        .filter((block) => block.includes("event: "))
        .map((block) => {
          const lines = block.split("\n");
          const field = (name: string) =>
            lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2) ?? null;

          return {
            id: field("id"),
            event: field("event") as string,
            data: JSON.parse(field("data") ?? "null"),
          };
        }),
  };
}

// Function สร้าง auth ของ Admin สำหรับเปิด SSE (ไม่ระบุ session ใช้เลขเดียวกับ account)
function adminAuth(accountId: number, sessionId = accountId) {
  return { account_id: accountId, role: "admin", session_id: sessionId, token_type: "access" } as any;
}

// Function ตั้งค่า env ชั่วคราวสำหรับ 1 test แล้วคืนค่าเดิมเสมอ
function withEnv(overrides: Record<string, string>, run: () => void): void {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));

  Object.assign(process.env, overrides);

  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/* -------------------------------------- Test Modules -------------------------------------- */

let notificationsService: typeof import("../../../src/services/notifications.service");

before(async () => {
  notificationsService = await import("../../../src/services/notifications.service");
});

// Function ส่ง event ธุรกิจถึง Admin ทุกคน
function publish(type: string, audience?: { account_ids?: number[]; roles?: string[] }) {
  notificationsService.publishNotification({
    type,
    title: type,
    message: type,
    payload: { marker: type },
    audience: audience ?? { roles: ["admin"] },
  });
}

/* -------------------------------------- Tests -------------------------------------- */

test("business events carry an SSE id while connected and other control events do not", () => {
  const client = createFakeSseResponse();

  notificationsService.subscribeAdminEvents(client.response as any, adminAuth(1));

  try {
    publish("REPLAY_ID_A");
    publish("REPLAY_ID_B");

    const events = client.events();
    const connected = events.find((event) => event.event === "connected");
    const [first, second] = events.filter((event) => event.event.startsWith("REPLAY_ID_"));

    assert.ok(connected);
    assert.equal(connected.id, null);
    assert.ok(first.id && second.id);
    assert.notEqual(first.id, second.id);
    assert.equal(first.id.split("-")[0], second.id.split("-")[0]);
    assert.equal(Number(second.id.split("-")[1]), Number(first.id.split("-")[1]) + 1);
  } finally {
    client.close();
  }
});

test("reconnecting with Last-Event-ID replays missed events in order before live events, without duplicates", () => {
  const first = createFakeSseResponse();

  notificationsService.subscribeAdminEvents(first.response as any, adminAuth(1));
  publish("REPLAY_ORDER_SEEN");

  const lastEventId = first.events().find((event) => event.event === "REPLAY_ORDER_SEEN")!.id!;

  first.close();
  publish("REPLAY_ORDER_MISSED_1");
  publish("REPLAY_ORDER_MISSED_2");

  const second = createFakeSseResponse();

  notificationsService.subscribeAdminEvents(second.response as any, adminAuth(1), lastEventId);

  try {
    publish("REPLAY_ORDER_LIVE");

    const names = second.events().map((event) => event.event);

    assert.deepEqual(names, ["connected", "REPLAY_ORDER_MISSED_1", "REPLAY_ORDER_MISSED_2", "REPLAY_ORDER_LIVE"]);
    assert.deepEqual(second.events()[1].data.Payload, { Marker: "REPLAY_ORDER_MISSED_1" });
  } finally {
    second.close();
  }
});

test("Last-Event-ID equal to the newest event replays nothing and does not request a resync", () => {
  const first = createFakeSseResponse();

  notificationsService.subscribeAdminEvents(first.response as any, adminAuth(1));
  publish("REPLAY_LATEST");

  const lastEventId = first.events().find((event) => event.event === "REPLAY_LATEST")!.id!;

  first.close();

  const second = createFakeSseResponse();

  notificationsService.subscribeAdminEvents(second.response as any, adminAuth(1), lastEventId);

  try {
    assert.deepEqual(second.events().map((event) => event.event), ["connected"]);
  } finally {
    second.close();
  }
});

test("replay filters events by the audience of the reconnecting account", () => {
  const observer = createFakeSseResponse();

  notificationsService.subscribeAdminEvents(observer.response as any, adminAuth(1));
  publish("REPLAY_AUDIENCE_START");

  const lastEventId = observer.events().find((event) => event.event === "REPLAY_AUDIENCE_START")!.id!;

  observer.close();
  publish("REPLAY_AUDIENCE_FOR_1", { account_ids: [1] });
  publish("REPLAY_AUDIENCE_FOR_2", { account_ids: [2] });
  publish("REPLAY_AUDIENCE_FOR_WORKER", { roles: ["worker"] });

  const accountTwo = createFakeSseResponse();

  notificationsService.subscribeAdminEvents(accountTwo.response as any, adminAuth(2), lastEventId);

  try {
    assert.deepEqual(accountTwo.events().map((event) => event.event), ["connected", "REPLAY_AUDIENCE_FOR_2"]);
  } finally {
    accountTwo.close();
  }
});

test("stale, unknown, foreign-epoch or future Last-Event-ID sends STREAM_RESYNC_REQUIRED and keeps streaming", () => {
  let staleId = "";

  withEnv({ ADMIN_SSE_REPLAY_MAX_EVENTS: "2" }, () => {
    const first = createFakeSseResponse();

    notificationsService.subscribeAdminEvents(first.response as any, adminAuth(1));
    publish("REPLAY_STALE_OLD");
    staleId = first.events().find((event) => event.event === "REPLAY_STALE_OLD")!.id!;
    first.close();
    publish("REPLAY_STALE_FILL_1");
    publish("REPLAY_STALE_FILL_2");
    publish("REPLAY_STALE_FILL_3");
  });

  const epoch = staleId.split("-")[0];
  const candidates = [staleId, "not-an-id", "garbage", `zzzz-1`, `${epoch}-999999999`];

  for (const lastEventId of candidates) {
    const client = createFakeSseResponse();

    notificationsService.subscribeAdminEvents(client.response as any, adminAuth(1), lastEventId);

    try {
      publish("REPLAY_STALE_LIVE");

      const events = client.events();

      assert.deepEqual(
        events.map((event) => event.event),
        ["connected", "STREAM_RESYNC_REQUIRED", "REPLAY_STALE_LIVE"],
        `Last-Event-ID ${lastEventId}`,
      );
      assert.equal(events[1].id, null);
      assert.equal(events[1].data.LastEventId, lastEventId);
    } finally {
      client.close();
    }
  }
});

test("closeAdminSseByAccount closes every tab of the revoked sessions and keeps the session that stays signed in", () => {
  const revokedTabA = createFakeSseResponse();
  const revokedTabB = createFakeSseResponse();
  const keptSession = createFakeSseResponse();
  const otherAccount = createFakeSseResponse();

  notificationsService.subscribeAdminEvents(revokedTabA.response as any, adminAuth(31, 310));
  notificationsService.subscribeAdminEvents(revokedTabB.response as any, adminAuth(31, 310));
  notificationsService.subscribeAdminEvents(keptSession.response as any, adminAuth(31, 311));
  notificationsService.subscribeAdminEvents(otherAccount.response as any, adminAuth(32));

  try {
    const closed = notificationsService.closeAdminSseByAccount(31, { reason: "password_changed" }, 311);

    publish("AFTER_REVOKE");

    assert.equal(closed, 2);
    assert.equal(revokedTabA.isEnded(), true);
    assert.equal(revokedTabB.isEnded(), true);
    assert.equal(revokedTabA.events().at(-1)?.event, "SESSION_REVOKED");
    assert.equal(revokedTabA.events().some((event) => event.event === "AFTER_REVOKE"), false);
    assert.equal(keptSession.isEnded(), false);
    assert.equal(keptSession.events().at(-1)?.event, "AFTER_REVOKE");
    assert.equal(otherAccount.events().at(-1)?.event, "AFTER_REVOKE");
  } finally {
    keptSession.close();
    otherAccount.close();
  }
});
