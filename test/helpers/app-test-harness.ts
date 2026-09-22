import crypto from "node:crypto";
import type { Server } from "node:http";
import Module = require("node:module");
import { normalizeApiRequestPayload } from "../../src/middlewares/api-case.middleware";
import { applyIsolatedTestEnv } from "../setup/test-env";
import { FakeQueue, FakeRedis, FakeWorker } from "./app-test-infra-mocks";
import type { AccountRecord } from "./app-test-harness.records";
import { lineActionTokenRepositoryMock, lineRepositoryMock, messageDeliveryLogRepositoryMock, notificationQueueMock, notificationServiceMock, realtimeNotificationServiceMock, workerSocketMock } from "./app-test-notification-mocks";
import { spacesMock } from "./app-test-spaces-mock";

export { resetSpacesMockState, spacesMockState } from "./app-test-spaces-mock";
import { accountRepositoryMock, adminActionLogRepositoryMock, adminAuditRepositoryMock, adminJobsRepositoryMock, adminSettingsRepositoryMock, adminWorkersRepositoryMock, authRepositoryMock, driverRepositoryMock, driverSessionRepositoryMock, gateClientRepositoryMock, boothJobRepositoryMock, gateRepositoryMock, masterWorkerRepositoryMock, mobileAppVersionRepositoryMock, marketJobRepositoryMock, masterDataRepositoryMock, securityAuditLogRepositoryMock, systemSettingRepositoryMock, ticketFinancialRepositoryMock, ticketWorkerRepositoryMock, ticketJobAssignmentRepositoryMock, ticketJobRepositoryMock, profileRepositoryMock, workerBreakLogRepositoryMock, workerCheckinLogRepositoryMock, workerNotificationRepositoryMock, workerPushTokenRepositoryMock, workerRepositoryMock, workerSessionRepositoryMock, workScheduleRepositoryMock } from "./app-test-repository-mocks";
import { state } from "./app-test-state";

export { state } from "./app-test-state";
export {
  addAdmin,
  addDispatchableJob,
  addGateClient,
  addMarketJobForVehicle,
  addMobileAppVersion,
  addPendingAssignment,
  addTicketForTicketJob,
  addWorker,
  resetRouteTestState,
} from "./app-test-fixtures";

/* -------------------------------------- Test Env -------------------------------------- */

applyIsolatedTestEnv("route-test");
process.env.WORKER_PRESENCE_STALE_SECONDS = "90";

/* -------------------------------------- Test Module Loader Types -------------------------------------- */

type ModuleLoad = (
  request: string,
  parent: NodeModule | null | undefined,
  isMain: boolean,
) => unknown;

type ModuleWithLoad = typeof Module & {
  _load: ModuleLoad;
};

const moduleWithLoad = Module as ModuleWithLoad;
const originalLoad = moduleWithLoad._load;
let patched = false;
let appModule: typeof import("../../src/app") | null = null;
let workerQueueModule: typeof import("../../src/queues/worker-queue") | null =
  null;
let workerDispatchModule:
  typeof import("../../src/queues/worker-dispatch") | null = null;
let passwordModule: typeof import("../../src/utils/password") | null = null;
let ticketFinancialModule:
  typeof import("../../src/services/shared/ticket-financial.service") | null =
  null;
let ticketCompletionModule:
  typeof import("../../src/services/shared/ticket-completion.service") | null =
  null;
/* -------------------------------------- Module Loader Patch -------------------------------------- */

// Function ตั้งค่า module loader จำลองสำหรับ route test
function patchModuleLoader(): void {
  if (patched) {
    return;
  }

  patched = true;
  moduleWithLoad._load = function patchedLoad(
    request: string,
    parent: NodeModule | null | undefined,
    isMain: boolean,
  ) {
    if (request === "ioredis") {
      return FakeRedis;
    }

    if (request === "bullmq") {
      return {
        Queue: FakeQueue,
        Worker: FakeWorker,
      };
    }

    if (request === "../db/prisma" || request === "../../db/prisma") {
      return {
        getPrisma: () => ({
          $queryRaw: async () => {
            if (process.env.TEST_READY_DB_FAIL === "1") {
              throw new Error("test database unavailable");
            }

            return [{ "?column?": 1 }];
          },
        }),
        withTransaction: async (
          callback: (transaction: unknown) => Promise<unknown>,
        ) =>
          callback({
            transaction: true,
            // Mock เฉยๆ สำหรับ raw lock query (เช่น SELECT ... FOR UPDATE) ที่บาง service เรียกผ่าน
            // connection.$queryRaw โดยตรง — test harness เป็น single-threaded ไม่มี concurrency จริง
            // ให้ทดสอบ จึงแค่ resolve เฉยๆ พอ ไม่ต้องจำลอง lock จริง
            $queryRaw: async () => [],
          }),
      };
    }

    if (
      request === "../repositories/worker.repository" ||
      request === "../../repositories/worker.repository"
    ) {
      return workerRepositoryMock;
    }

    if (
      request === "../repositories/driver.repository" ||
      request === "../../repositories/driver.repository"
    ) {
      return driverRepositoryMock;
    }

    if (
      request === "../repositories/shared/driver-session.repository" ||
      request === "../../repositories/shared/driver-session.repository"
    ) {
      return driverSessionRepositoryMock;
    }

    if (
      request === "../repositories/shared/line-action-token.repository" ||
      request === "../../repositories/shared/line-action-token.repository"
    ) {
      return lineActionTokenRepositoryMock;
    }

    if (
      request === "../repositories/shared/message-delivery-log.repository" ||
      request === "../../repositories/shared/message-delivery-log.repository"
    ) {
      return messageDeliveryLogRepositoryMock;
    }

    if (
      request === "../repositories/shared/ticket-job-assignment.repository" ||
      request === "../../repositories/shared/ticket-job-assignment.repository"
    ) {
      return ticketJobAssignmentRepositoryMock;
    }

    if (
      request === "../repositories/shared/ticket-job.repository" ||
      request === "../../repositories/shared/ticket-job.repository"
    ) {
      return ticketJobRepositoryMock;
    }

    if (
      request === "../repositories/shared/account.repository" ||
      request === "../../repositories/shared/account.repository"
    ) {
      return accountRepositoryMock;
    }

    if (
      request === "../repositories/shared/master-worker.repository" ||
      request === "../../repositories/shared/master-worker.repository"
    ) {
      return masterWorkerRepositoryMock;
    }

    if (
      request === "../repositories/shared/worker-session.repository" ||
      request === "../../repositories/shared/worker-session.repository"
    ) {
      return workerSessionRepositoryMock;
    }

    if (
      request === "../repositories/shared/profile.repository" ||
      request === "../../repositories/shared/profile.repository"
    ) {
      return profileRepositoryMock;
    }

    if (
      request === "../repositories/shared/worker-notification.repository" ||
      request === "../../repositories/shared/worker-notification.repository"
    ) {
      return workerNotificationRepositoryMock;
    }

    if (
      request === "../repositories/shared/worker-push-token.repository" ||
      request === "../../repositories/shared/worker-push-token.repository"
    ) {
      return workerPushTokenRepositoryMock;
    }

    if (
      request === "../repositories/shared/work-schedule.repository" ||
      request === "../../repositories/shared/work-schedule.repository"
    ) {
      return workScheduleRepositoryMock;
    }

    if (
      request === "../repositories/shared/worker-checkin-log.repository" ||
      request === "../../repositories/shared/worker-checkin-log.repository"
    ) {
      return workerCheckinLogRepositoryMock;
    }

    if (
      request === "../repositories/shared/worker-break-log.repository" ||
      request === "../../repositories/shared/worker-break-log.repository"
    ) {
      return workerBreakLogRepositoryMock;
    }

    if (
      request === "../repositories/shared/booth-job.repository" ||
      request === "../../repositories/shared/booth-job.repository"
    ) {
      return boothJobRepositoryMock;
    }

    if (
      request === "../repositories/shared/ticket-financial.repository" ||
      request === "../../repositories/shared/ticket-financial.repository"
    ) {
      return ticketFinancialRepositoryMock;
    }

    if (
      request === "../repositories/shared/ticket-worker.repository" ||
      request === "../../repositories/shared/ticket-worker.repository"
    ) {
      return ticketWorkerRepositoryMock;
    }

    if (
      request === "../repositories/shared/market-job.repository" ||
      request === "../../repositories/shared/market-job.repository"
    ) {
      return marketJobRepositoryMock;
    }

    if (
      request === "../repositories/shared/master-data.repository" ||
      request === "../../repositories/shared/master-data.repository"
    ) {
      return masterDataRepositoryMock;
    }

    if (
      request === "../repositories/shared/admin-action-log.repository" ||
      request === "../../repositories/shared/admin-action-log.repository"
    ) {
      return adminActionLogRepositoryMock;
    }

    if (
      request === "../repositories/shared/security-audit-log.repository" ||
      request === "../../repositories/shared/security-audit-log.repository"
    ) {
      return securityAuditLogRepositoryMock;
    }

    if (request === "../repositories/admin-jobs.repository") {
      return adminJobsRepositoryMock;
    }

    if (request === "../repositories/admin-audit.repository") {
      return adminAuditRepositoryMock;
    }

    if (request === "../repositories/gate.repository") {
      return gateRepositoryMock;
    }

    if (
      request === "../repositories/auth.repository" ||
      request === "../../repositories/auth.repository"
    ) {
      return authRepositoryMock;
    }

    if (request === "../repositories/admin-workers.repository") {
      return adminWorkersRepositoryMock;
    }

    if (request === "../repositories/admin-settings.repository") {
      return adminSettingsRepositoryMock;
    }

    if (
      request === "../repositories/shared/gate-client.repository" ||
      request === "../../repositories/shared/gate-client.repository"
    ) {
      return gateClientRepositoryMock;
    }

    if (
      request === "../repositories/shared/mobile-app-version.repository" ||
      request === "../../repositories/shared/mobile-app-version.repository"
    ) {
      return mobileAppVersionRepositoryMock;
    }

    if (
      request === "../repositories/shared/system-setting.repository" ||
      request === "../../repositories/shared/system-setting.repository"
    ) {
      return systemSettingRepositoryMock;
    }

    if (
      request === "../repositories/shared/permission.repository" ||
      request === "../../repositories/shared/permission.repository"
    ) {
      return adminSettingsRepositoryMock.permissionRepository;
    }

    if (
      request === "../repositories/shared/session.repository" ||
      request === "../../repositories/shared/session.repository"
    ) {
      return adminSettingsRepositoryMock.sessionRepository;
    }

    if (
      request === "../services/admin-settings.service" ||
      request === "./admin-settings.service"
    ) {
      const parentFilename = (parent?.filename ?? "").replaceAll("\\", "/");

      if (
        parentFilename.endsWith("routes/admin-settings.routes.ts") ||
        parentFilename.endsWith("middlewares/gate-client-auth.middleware.ts")
      ) {
        return originalLoad.apply(this, [request, parent, isMain]);
      }

      return {
        getRuntimeSettings: async () => ({
          worker_accept_deadline_seconds: 60,
          worker_accept_timeout_limit: 3,
          worker_scan_deadline_minutes: 15,
          worker_scan_warning_before_minutes: 2,
          worker_scan_team_remaining_minutes: 5,
          worker_break_duration_minutes: 15,
          worker_break_limit: 4,
          worker_break_count_ttl_hours: 48,
          worker_break_retry: 1,
          worker_presence_stale_seconds: 90,
          vendor_confirm_timeout_hours: 24,
          vendor_reconfirm_timeout_hours: 4,
          driver_session_ttl_hours: 24,
        }),
        getAccountPermissions: async (account: AccountRecord) => ({
          account_id: account.id,
          role: account.role,
          permission_level: account.permission_level,
          permissions: state.adminPermissions.get(account.id) ?? [],
        }),
      };
    }

    if (
      request === "./shared/runtime-settings.service" ||
      request === "./runtime-settings.service" ||
      request === "../services/shared/runtime-settings.service" ||
      request === "../../services/shared/runtime-settings.service"
    ) {
      return {
        clearRuntimeSettingsCache: () => undefined,
        getRuntimeSettings: async () => ({
          worker_accept_deadline_seconds: 60,
          worker_accept_timeout_limit: 3,
          worker_scan_deadline_minutes: 15,
          worker_scan_warning_before_minutes: 2,
          worker_scan_team_remaining_minutes: 5,
          worker_break_duration_minutes: 15,
          worker_break_limit: 4,
          worker_break_count_ttl_hours: 48,
          worker_break_retry: 1,
          worker_presence_stale_seconds: 90,
          vendor_confirm_timeout_hours: 24,
          vendor_reconfirm_timeout_hours: 4,
          driver_session_ttl_hours: 24,
        }),
      };
    }

    if (
      request === "./shared/account-permission.service" ||
      request === "../services/shared/account-permission.service" ||
      request === "../../services/shared/account-permission.service"
    ) {
      return {
        getAccountPermissions: async (account: AccountRecord) => ({
          account_id: account.id,
          role: account.role,
          status: account.status,
          permission_level: account.permission_level,
          permissions: state.adminPermissions.get(account.id) ?? [],
        }),
      };
    }

    if (
      request === "../services/notifications.service" ||
      request === "./notifications.service" ||
      request === "../notifications.service"
    ) {
      return notificationServiceMock;
    }

    if (
      request === "./realtime-notification.service" ||
      request === "./shared/realtime-notification.service" ||
      request === "../services/shared/realtime-notification.service" ||
      request === "../../services/shared/realtime-notification.service"
    ) {
      return realtimeNotificationServiceMock;
    }

    if (
      request === "./shared/worker-assignment-event.repository" ||
      request === "../repositories/shared/worker-assignment-event.repository" ||
      request === "../../repositories/shared/worker-assignment-event.repository"
    ) {
      return {
        createOnce: adminAuditRepositoryMock.createWorkerAssignmentEventOnce,
        createManyOnce:
          adminAuditRepositoryMock.createWorkerAssignmentEventsOnce,
        findMetadataByAssignmentAndType:
          adminAuditRepositoryMock.findWorkerAssignmentEventMetadataByAssignmentAndType,
      };
    }

    if (request === "../websockets/worker.socket") {
      return workerSocketMock;
    }

    if (
      request === "../queues/line-message-queue" ||
      request === "../../queues/line-message-queue"
    ) {
      return notificationQueueMock;
    }

    if (
      request === "../repositories/line.repository" ||
      request === "../../repositories/line.repository"
    ) {
      return lineRepositoryMock;
    }

    if (
      request === "../config/spaces" ||
      request === "../../config/spaces"
    ) {
      return spacesMock;
    }

    return originalLoad.apply(this, [request, parent, isMain]);
  };
}

/* -------------------------------------- Module Getters -------------------------------------- */

// Function ดึง password สำหรับ test
export async function getPassword() {
  patchModuleLoader();
  passwordModule ??= await import("../../src/utils/password");
  return passwordModule;
}

// Function ดึง worker queue สำหรับ test
export async function getWorkerQueue() {
  patchModuleLoader();
  workerQueueModule ??= await import("../../src/queues/worker-queue");
  return workerQueueModule;
}

// Function ดึง worker dispatch สำหรับ test
export async function getWorkerDispatch() {
  patchModuleLoader();
  workerDispatchModule ??= await import("../../src/queues/worker-dispatch");
  return workerDispatchModule;
}

// Function ดึง Ticket Financial service สำหรับ test
export async function getTicketFinancialService() {
  patchModuleLoader();
  ticketFinancialModule ??=
    await import("../../src/services/shared/ticket-financial.service");
  return ticketFinancialModule;
}

// Function ดึง Ticket Completion service สำหรับ test
export async function getTicketCompletionService() {
  patchModuleLoader();
  ticketCompletionModule ??=
    await import("../../src/services/shared/ticket-completion.service");
  return ticketCompletionModule;
}

/* -------------------------------------- LINE Webhook Signing -------------------------------------- */

// Function เซ็น body สำหรับยิง /api/line/webhook เหมือน LINE ส่งจริง (server.request JSON.stringify
// body ก่อนส่งเสมอ ต้อง stringify แบบเดียวกันตรงนี้เพื่อให้ signature ตรงกับ raw body ที่ฝั่ง server เห็น)
export function signLineWebhookBody(
  body: unknown,
  secret = process.env.LINE_CHANNEL_SECRET!,
): string {
  return crypto
    .createHmac("sha256", secret)
    .update(JSON.stringify(body))
    .digest("base64");
}

/* -------------------------------------- Test Server -------------------------------------- */

export type TestServer = {
  request: (
    method: string,
    path: string,
    options?: {
      body?: unknown;
      token?: string;
      headers?: Record<string, string>;
      external?: boolean;
    },
  ) => Promise<{ status: number; body: any; headers: Headers }>;
  close: () => Promise<void>;
};

// Function ตรวจว่า return external body สำหรับ test
function shouldReturnExternalBody(
  body: unknown,
  forceExternal?: boolean,
): boolean {
  return Boolean(
    forceExternal ||
    (body &&
      typeof body === "object" &&
      ("Result" in body || "Ticket" in body)),
  );
}

// Function เริ่ม server จำลองสำหรับ test route API
export async function startRouteTestServer(): Promise<TestServer> {
  patchModuleLoader();
  appModule ??= await import("../../src/app");

  const server: Server = appModule.default.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Test server address is not available.");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    request: async (method, path, options = {}) => {
      // FormData ต้องปล่อยให้ fetch ตั้ง Content-Type (multipart boundary) เอง ห้าม JSON.stringify
      const isFormData = options.body instanceof FormData;
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(options.body === undefined || isFormData
            ? {}
            : { "Content-Type": "application/json" }),
          ...(options.token
            ? { Authorization: `Bearer ${options.token}` }
            : {}),
          ...(options.headers ?? {}),
        },
        body:
          options.body === undefined
            ? undefined
            : isFormData
              ? (options.body as FormData)
              : JSON.stringify(options.body),
      });
      const text = await response.text();
      const parsedBody = text ? JSON.parse(text) : null;

      return {
        status: response.status,
        headers: response.headers,
        body: shouldReturnExternalBody(parsedBody, options.external)
          ? parsedBody
          : normalizeApiRequestPayload(parsedBody),
      };
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}

// Function คืน module loader กลับสู่สภาพเดิมหลัง test
export function restoreRouteTestLoader(): void {
  if (!patched) {
    return;
  }

  moduleWithLoad._load = originalLoad;
  patched = false;
}
