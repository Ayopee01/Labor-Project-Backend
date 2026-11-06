// Import Library
import assert from "node:assert/strict";
import { before, test } from "node:test";
// Import Helpers
import { openSseTestClient, type SseTestClient } from "../../helpers/sse-test-client";

/* -------------------------------------- Test Env -------------------------------------- */

process.env.JWT_ACCESS_SECRET ??= "test-access-secret-min-32-charss";
process.env.JWT_REFRESH_SECRET ??= "test-refresh-secret-min-32-chars";
process.env.JWT_LOGIN_CHALLENGE_SECRET ??= "test-login-challenge-secret-min-32";
process.env.REFRESH_TOKEN_HASH_SECRET ??= "test-refresh-hash-secret-min-32-ok";

/* -------------------------------------- Helpers -------------------------------------- */

// Function สร้าง auth ของ Admin สำหรับเปิด SSE (ไม่ระบุ session ใช้เลขเดียวกับ account)
function adminAuth(accountId: number, sessionId = accountId) {
  return { account_id: accountId, role: "admin", session_id: sessionId, token_type: "access" } as any;
}

// Function ตั้งค่า env ชั่วคราวสำหรับ 1 test แล้วคืนค่าเดิมเสมอ
async function withEnv(overrides: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));

  Object.assign(process.env, overrides);

  try {
    await run();
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

// Function เปิด Admin SSE ผ่าน HTTP จริง
function subscribe(auth: ReturnType<typeof adminAuth>, lastEventId?: string): Promise<SseTestClient> {
  return openSseTestClient((response) => notificationsService.subscribeAdminEvents(response, auth, lastEventId));
}

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

test("business events carry an SSE id while connected and other control events do not", async () => {
  const client = await subscribe(adminAuth(1));

  try {
    publish("REPLAY_ID_A");
    publish("REPLAY_ID_B");
    await client.flush();

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
    await client.close();
  }
});

test("reconnecting with Last-Event-ID replays missed events in order before live events, without duplicates", async () => {
  const first = await subscribe(adminAuth(1));

  publish("REPLAY_ORDER_SEEN");
  await first.flush();

  const lastEventId = first.events().find((event) => event.event === "REPLAY_ORDER_SEEN")!.id!;

  await first.close();
  publish("REPLAY_ORDER_MISSED_1");
  publish("REPLAY_ORDER_MISSED_2");

  const second = await subscribe(adminAuth(1), lastEventId);

  try {
    publish("REPLAY_ORDER_LIVE");
    await second.flush();

    const names = second.events().map((event) => event.event);

    assert.deepEqual(names, ["connected", "REPLAY_ORDER_MISSED_1", "REPLAY_ORDER_MISSED_2", "REPLAY_ORDER_LIVE"]);
    assert.deepEqual(second.events()[1].data.Payload, { Marker: "REPLAY_ORDER_MISSED_1" });
  } finally {
    await second.close();
  }
});

test("Last-Event-ID equal to the newest event replays nothing and does not request a resync", async () => {
  const first = await subscribe(adminAuth(1));

  publish("REPLAY_LATEST");
  await first.flush();

  const lastEventId = first.events().find((event) => event.event === "REPLAY_LATEST")!.id!;

  await first.close();

  const second = await subscribe(adminAuth(1), lastEventId);

  try {
    assert.deepEqual(second.events().map((event) => event.event), ["connected"]);
  } finally {
    await second.close();
  }
});

test("replay filters events by the audience of the reconnecting account", async () => {
  const observer = await subscribe(adminAuth(1));

  publish("REPLAY_AUDIENCE_START");
  await observer.flush();

  const lastEventId = observer.events().find((event) => event.event === "REPLAY_AUDIENCE_START")!.id!;

  await observer.close();
  publish("REPLAY_AUDIENCE_FOR_1", { account_ids: [1] });
  publish("REPLAY_AUDIENCE_FOR_2", { account_ids: [2] });
  publish("REPLAY_AUDIENCE_FOR_WORKER", { roles: ["worker"] });

  const accountTwo = await subscribe(adminAuth(2), lastEventId);

  try {
    assert.deepEqual(accountTwo.events().map((event) => event.event), ["connected", "REPLAY_AUDIENCE_FOR_2"]);
  } finally {
    await accountTwo.close();
  }
});

test("stale, unknown, foreign-epoch or future Last-Event-ID sends STREAM_RESYNC_REQUIRED and keeps streaming", async () => {
  let staleId = "";

  await withEnv({ ADMIN_SSE_REPLAY_MAX_EVENTS: "2" }, async () => {
    const first = await subscribe(adminAuth(1));

    publish("REPLAY_STALE_OLD");
    await first.flush();
    staleId = first.events().find((event) => event.event === "REPLAY_STALE_OLD")!.id!;
    await first.close();
    publish("REPLAY_STALE_FILL_1");
    publish("REPLAY_STALE_FILL_2");
    publish("REPLAY_STALE_FILL_3");
  });

  const epoch = staleId.split("-")[0];
  const candidates = [staleId, "not-an-id", "garbage", `zzzz-1`, `${epoch}-999999999`];

  for (const lastEventId of candidates) {
    const client = await subscribe(adminAuth(1), lastEventId);

    try {
      publish("REPLAY_STALE_LIVE");
      await client.flush();

      const events = client.events();

      assert.deepEqual(
        events.map((event) => event.event),
        ["connected", "STREAM_RESYNC_REQUIRED", "REPLAY_STALE_LIVE"],
        `Last-Event-ID ${lastEventId}`,
      );
      assert.equal(events[1].id, null);
      assert.equal(events[1].data.LastEventId, lastEventId);
    } finally {
      await client.close();
    }
  }
});

test("closeAdminSseByAccount closes every tab of the revoked sessions and keeps the session that stays signed in", async () => {
  const revokedTabA = await subscribe(adminAuth(31, 310));
  const revokedTabB = await subscribe(adminAuth(31, 310));
  const keptSession = await subscribe(adminAuth(31, 311));
  const otherAccount = await subscribe(adminAuth(32));

  try {
    const closed = notificationsService.closeAdminSseByAccount(31, { reason: "password_changed" }, 311);

    publish("AFTER_REVOKE");
    await keptSession.flush();

    assert.equal(closed, 2);
    assert.equal(revokedTabA.isEnded(), true);
    assert.equal(revokedTabB.isEnded(), true);
    assert.equal(revokedTabA.events().at(-1)?.event, "SESSION_REVOKED");
    assert.equal(revokedTabA.events().some((event) => event.event === "AFTER_REVOKE"), false);
    assert.equal(keptSession.isEnded(), false);
    assert.equal(keptSession.events().at(-1)?.event, "AFTER_REVOKE");
    assert.equal(otherAccount.events().at(-1)?.event, "AFTER_REVOKE");
  } finally {
    await Promise.all([revokedTabA, revokedTabB, keptSession, otherAccount].map((client) => client.close()));
  }
});
