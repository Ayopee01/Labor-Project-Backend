import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import Module = require("node:module");

/* -------------------------------------- Test Env -------------------------------------- */

// Firebase env ต้องครบก่อนเรียกครั้งแรก เพราะ worker-push.service cache ผลการเช็ค env ไว้ตลอดอายุ process
process.env.FIREBASE_PROJECT_ID = "test-project";
process.env.FIREBASE_CLIENT_EMAIL = "test@test-project.iam.gserviceaccount.com";
process.env.FIREBASE_PRIVATE_KEY = "test-private-key";

/* -------------------------------------- Fakes -------------------------------------- */

type FakeSendResponse = { success: boolean; error?: { code: string; message: string } };

// State ของ fake ที่แต่ละ test กำหนดผลลัพธ์ของ FCM และตรวจสิ่งที่ service เขียนกลับได้
const fake = {
  tokens: [] as Array<{ worker_code: string; fcm_token: string; fcm_token_hash: string }>,
  sendResponses: [] as FakeSendResponse[],
  createdLogs: 0,
  statusUpdates: [] as Array<{ status: string; error: string | null }>,
  revokedHashes: [] as string[],
};

type ModuleLoad = (request: string, parent: NodeModule | null | undefined, isMain: boolean) => unknown;
const moduleWithLoad = Module as typeof Module & { _load: ModuleLoad };
const originalLoad = moduleWithLoad._load;

// Function แทน module ภายนอก (Firebase/Repository) ด้วย fake ก่อน require service — pattern เดียวกับ app-test-harness
moduleWithLoad._load = function patchedLoad(request, parent, isMain) {
  if (request === "firebase-admin/app") {
    return { cert: () => ({}), getApps: () => [{}], initializeApp: () => ({}) };
  }

  if (request === "firebase-admin/messaging") {
    return {
      getMessaging: () => ({
        sendEachForMulticast: async ({ tokens }: { tokens: string[] }) => {
          const responses = tokens.map((_, index) => fake.sendResponses[index] ?? { success: true });

          return {
            responses,
            successCount: responses.filter((item) => item.success).length,
            failureCount: responses.filter((item) => !item.success).length,
          };
        },
      }),
    };
  }

  if (request.endsWith("repositories/shared/master-worker.repository")) {
    return {
      findById: async () => null,
      listByIds: async (ids: number[]) =>
        ids.map((id) => ({ id, labor_code: `W${id}`, lang: "TH" })),
      listActiveByLaborCodes: async () => [],
    };
  }

  if (request.endsWith("repositories/shared/worker-push-token.repository")) {
    return {
      listActiveTokensByWorkerCodes: async () => fake.tokens,
      revokeByTokenHashes: async (hashes: string[]) => {
        fake.revokedHashes.push(...hashes);
      },
    };
  }

  if (request.endsWith("repositories/shared/message-delivery-log.repository")) {
    return {
      MESSAGE_DELIVERY_STATUS: { PENDING: "PENDING", SENT: "SENT", FAILED: "FAILED" },
      createMessageDeliveryLog: async () => {
        fake.createdLogs += 1;
        return fake.createdLogs;
      },
      updateMessageDeliveryLogStatus: async (_id: number, status: string, error: string | null) => {
        fake.statusUpdates.push({ status, error });
      },
    };
  }

  return originalLoad(request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const workerPush = require("../../../src/services/shared/worker-push.service") as typeof import("../../../src/services/shared/worker-push.service");

/* -------------------------------------- Helpers -------------------------------------- */

function sendCancelledPush(): Promise<void> {
  return workerPush.sendWorkerPushNotificationByWorkerIds({
    worker_ids: [1],
    type: "ASSIGNMENT_CANCELLED",
    title: "Assignment cancelled",
    message: "Your assignment was cancelled.",
    payload: { ticketNumber: "JOB-1", reason: "admin_cancel_assignment" },
  });
}

beforeEach(() => {
  fake.tokens = [
    { worker_code: "W1", fcm_token: "token-a", fcm_token_hash: "hash-a" },
    { worker_code: "W1", fcm_token: "token-b", fcm_token_hash: "hash-b" },
  ];
  fake.sendResponses = [];
  fake.createdLogs = 0;
  fake.statusUpdates = [];
  fake.revokedHashes = [];
});

/* -------------------------------------- Tests -------------------------------------- */

test("worker push marks the delivery log FAILED (with error codes) when FCM rejects every token, instead of SENT", async () => {
  fake.sendResponses = [
    { success: false, error: { code: "messaging/invalid-argument", message: "Invalid payload" } },
    { success: false, error: { code: "messaging/invalid-argument", message: "Invalid payload" } },
  ];

  await sendCancelledPush();

  assert.equal(fake.statusUpdates.length, 1);
  assert.equal(fake.statusUpdates[0].status, "FAILED");
  assert.match(fake.statusUpdates[0].error ?? "", /messaging\/invalid-argument/);
  // invalid-argument อาจมาจาก payload ไม่ใช่ token เสีย — ต้องไม่ revoke token ทิ้ง
  assert.deepEqual(fake.revokedHashes, []);
});

test("worker push stays SENT when at least one token succeeds, and revokes only tokens FCM reports as unregistered", async () => {
  fake.sendResponses = [
    { success: false, error: { code: "messaging/registration-token-not-registered", message: "Not registered" } },
    { success: true },
  ];

  await sendCancelledPush();

  assert.equal(fake.statusUpdates[0].status, "SENT");
  assert.match(fake.statusUpdates[0].error ?? "", /registration-token-not-registered/);
  assert.deepEqual(fake.revokedHashes, ["hash-a"]);
});

test("worker push stays SENT with no error when every token succeeds", async () => {
  await sendCancelledPush();

  assert.deepEqual(fake.statusUpdates, [{ status: "SENT", error: null }]);
  assert.deepEqual(fake.revokedHashes, []);
});

test("worker push skips sending (and creates no delivery log) when the worker has no active push token", async () => {
  fake.tokens = [];

  await sendCancelledPush();

  assert.equal(fake.createdLogs, 0);
  assert.deepEqual(fake.statusUpdates, []);
});
