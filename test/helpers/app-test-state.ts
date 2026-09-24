import type { AccountRecord, AdminActionLogRecord, AssignmentRecord, DriverSessionRecord, GateClientRecord, GateRequestLogRecord, BoothJobRecord, BoothJobWorkerExclusionRecord, BoothJobWorkerSnapshotRecord, LineActionTokenRecord, MarketJobRecord, MasterWorkerRecord, MessageDeliveryLogRecord, MobileAppVersionRecord, MasterMarketRecord, MasterMemberStallRecord, MasterOwnerStallRecord, MasterProductRecord, MasterRateRecord, SecurityAuditLogRecord, SubmissionWorkerSnapshotRecord, TicketCompletionSubmissionRecord, TicketProductFinancialRecord, TicketProductRecord, TicketRatingRecord, TicketWorkerPaymentRecord, TicketWorkerRecord, TicketJobRecord, WorkerAssignmentEventRecord, WorkerBreakLogRecord, WorkerNotificationRecord, WorkerCheckinLogRecord } from "./app-test-harness.records";

/* -------------------------------------- Shared Test State -------------------------------------- */

export const state = {
  connectedWorkers: new Set<number>(),
  socketEvents: [] as Array<{
    workerId: number;
    event: string;
    payload: unknown;
  }>,
  notifications: [] as unknown[],
  realtimeEvents: [] as unknown[],
  lineMessages: [] as unknown[],
  workerPushTokens: [] as Array<{
    worker_id: number;
    worker_code: string;
    session_id: number | null;
    device_id: string;
    platform: string;
    fcm_token: string;
    fcm_token_hash: string;
    is_active: boolean;
  }>,
  workerNotifications: [] as WorkerNotificationRecord[],
  workers: new Map<number, MasterWorkerRecord>(),
  workersByLaborCode: new Map<string, MasterWorkerRecord>(),
  workerSessions: new Map<number, Record<string, unknown>>(),
  schedules: new Map<number, unknown>(),
  ticketJobs: [] as TicketJobRecord[],
  marketJobs: [] as MarketJobRecord[],
  assignments: [] as AssignmentRecord[],
  workerAssignmentEvents: [] as WorkerAssignmentEventRecord[],
  boothJobs: [] as BoothJobRecord[],

  ticketProducts: [] as TicketProductRecord[],
  ticketWorkers: [] as TicketWorkerRecord[],
  ticketProductFinancials: [] as TicketProductFinancialRecord[],
  ticketWorkerPayments: [] as TicketWorkerPaymentRecord[],
  boothJobWorkerSnapshots: [] as BoothJobWorkerSnapshotRecord[],
  boothJobWorkerExclusions: [] as BoothJobWorkerExclusionRecord[],
  submissionWorkerSnapshots: [] as SubmissionWorkerSnapshotRecord[],
  completionSubmissions: [] as TicketCompletionSubmissionRecord[],

  adminActionLogs: [] as AdminActionLogRecord[],
  securityAuditLogs: [] as SecurityAuditLogRecord[],
  // 27.14.2 — toggle เพื่อจำลอง audit write ล้มเหลว (เช่น DB error จริง) สำหรับ test ที่ verify ว่า
  // mutation ที่เขียนคู่กับ audit ใน transaction เดียวกันต้อง fail ไปด้วย ไม่ใช่แค่ audit พังแต่
  // mutation สำเร็จค้างไว้
  forceSecurityAuditLogWriteFailure: false,
  ticketRatings: [] as TicketRatingRecord[],
  lineActionTokens: [] as LineActionTokenRecord[],
  gateRequestLogs: [] as GateRequestLogRecord[],
  driverSessions: [] as DriverSessionRecord[],
  messageDeliveryLogs: [] as MessageDeliveryLogRecord[],
  masterMarkets: [] as MasterMarketRecord[],
  masterProducts: [] as MasterProductRecord[],
  masterRates: [] as MasterRateRecord[],
  masterOwnerStalls: [] as MasterOwnerStallRecord[],
  masterMemberStalls: [] as MasterMemberStallRecord[],
  gateClients: new Map<string, GateClientRecord>(),
  mobileAppVersions: [] as MobileAppVersionRecord[],
  checkinLogs: [] as WorkerCheckinLogRecord[],
  breakLogs: [] as WorkerBreakLogRecord[],
  authAccountsByUsername: new Map<string, AccountRecord>(),
  authAccountsById: new Map<number, AccountRecord>(),
  adminPermissions: new Map<number, string[]>(),
  profiles: new Map<number, unknown>(),
  authSchedules: new Map<number, unknown>(),
  sessions: new Map<number, Record<string, unknown>>(),
  queueJobs: new Map<
    string,
    // state จำลองสถานะ BullMQ job (ไม่ระบุ = "delayed") ให้ test จำลอง job ที่ failed/active ได้
    Map<string, { data: unknown; removed: boolean; state?: string }>
  >(),
  workerProcessors: new Map<
    string,
    (job: { data: unknown }) => Promise<void>
  >(),
  nextMarketJobId: 1,
  nextAssignmentId: 1,
  nextWorkerAssignmentEventId: 1,
  nextWorkerNotificationId: 1,
  nextSessionId: 1,
  nextWorkerSessionId: 1,
  nextTicketWorkerId: 1,
  nextTicketProductFinancialId: 1,
  nextTicketWorkerPaymentId: 1,
  nextBoothJobWorkerSnapshotId: 1,
  nextBoothJobWorkerExclusionId: 1,
  nextSubmissionWorkerSnapshotId: 1,
  nextSubmissionId: 1,
  nextRatingId: 1,
  nextLineActionTokenId: 1,
  nextGateClientId: 1,
  nextCheckinLogId: 1,
  nextBreakLogId: 1,
  nextAdminActionLogId: 1,
  nextSecurityAuditLogId: 1,
  nextMobileAppVersionId: 1,
  nextGateRequestLogId: 1,
  nextDriverSessionId: 1,
  nextMessageDeliveryLogId: 1,
};
