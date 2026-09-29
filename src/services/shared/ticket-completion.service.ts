// Import Config
import { ASSIGNMENT_STATUS, TICKET_STATUS, TICKET_SUBMITTER_ROLE, TICKET_WORKER_STATUS } from "../../constants/status";
// Import Repositories
import * as profileRepository from "../../repositories/shared/profile.repository";
import * as assignmentRepository from "../../repositories/shared/ticket-job-assignment.repository";
import * as boothJobRepository from "../../repositories/shared/booth-job.repository";
import * as marketJobRepository from "../../repositories/shared/market-job.repository";
import * as lineActionTokenRepository from "../../repositories/shared/line-action-token.repository";
import * as ticketJobRepository from "../../repositories/shared/ticket-job.repository";
// Import Services
import * as ticketJobLifecycleService from "./ticket-job-lifecycle.service";
import * as rateResolutionService from "./rate-resolution.service";
import { getRuntimeSettings } from "./runtime-settings.service";
import { resolveTicketResultAudience, publishRealtimeEvent } from "./realtime-notification.service";
// Import Queues
import { hasVendorConfirmationTimeout, scheduleVendorConfirmationTimeout } from "../../queues/worker-queue";
import { enqueueLoggedLineMessage } from "../../queues/line-message-queue";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";
import type { LineMessage } from "../../types/line.type";
import type { VendorTicketCompletionAction, VendorTicketCompletionFlowResult } from "../../types/line.type";
import type { BoothJobDto, TicketCompletionSubmissionDto, TicketProductConfirmationInput, TicketProductDto, VendorLineTargetDto, TicketJobDetailResponse } from "../../types/worker.type";
// Import Utils
import { buildVendorCompletionReviewFlexMessage } from "../../utils/line-flex-message";
import { buildWorkerTicketPayload } from "../../utils/ticket-payload";
import ApiError from "../../utils/api-error";
import { logger } from "../../utils/logger";

/* -------------------------------------- Vendor Result -------------------------------------- */

// Function ประมวลผล confirm/reject จาก vendor และเตรียม payload realtime กลาง
export async function applyVendorTicketCompletionResult(input: {
  ticket: BoothJobDto;
  submission: TicketCompletionSubmissionDto;
  action: VendorTicketCompletionAction;
  rejectReason?: string | null;
  resolvedByLineUserId?: string | null;
  connection: DbConnection;
}): Promise<VendorTicketCompletionFlowResult> {
  const isConfirmed = input.action === "confirm";
  const updated = isConfirmed
    ? await boothJobRepository.confirmTicketCompletion(
        input.ticket.id,
        input.submission.id,
        input.connection,
        input.resolvedByLineUserId,
      )
    : await boothJobRepository.rejectTicketCompletion(
        input.ticket.id,
        input.submission.id,
        input.rejectReason,
        input.connection,
        input.resolvedByLineUserId,
      );

  // การเงิน finalize ตอนทุก Booth จบใน closeCompletedTicketJobIfReady ไม่ใช่ที่นี่
  const completedTicketJob = isConfirmed
    ? await ticketJobLifecycleService.closeCompletedTicketJobIfReady(
        updated.ticket.vehicle_job_id,
        input.connection,
      )
    : null;
  const nextTicket =
    isConfirmed && !completedTicketJob
      ? await ticketJobLifecycleService.activateNextTicketIfReady(
          updated.ticket.vehicle_job_id,
          input.connection,
        )
      : null;

  if (isConfirmed && !completedTicketJob) {
    await assignmentRepository.setVehicleAssignmentsStatus(
      updated.ticket.vehicle_job_id,
      ASSIGNMENT_STATUS.WORKING,
      input.connection,
    );
  }

  if (!isConfirmed) {
    await assignmentRepository.setVehicleAssignmentsStatus(
      updated.ticket.vehicle_job_id,
      ASSIGNMENT_STATUS.REJECT,
      input.connection,
    );
  }

  const [receiverAccountIds, products, detail] = await Promise.all([
    resolveTicketResultAudience(updated.ticket, input.connection),
    boothJobRepository.listTicketProducts(
      updated.ticket.id,
      input.connection,
    ),
    ticketJobRepository.getTicketJobDetail(
      updated.ticket.vehicle_job_id,
      input.connection,
    ),
  ]);
  const completedWorkerCodes = completedTicketJob
    ? await profileRepository.findWorkerCodesByAccountIds(
        completedTicketJob.completed_worker_ids,
        input.connection,
      )
    : [];
  const assignmentStatus = isConfirmed
    ? completedTicketJob
      ? ASSIGNMENT_STATUS.COMPLETED
      : ASSIGNMENT_STATUS.WORKING
    : ASSIGNMENT_STATUS.REJECT;

  return {
    ...updated,
    products,
    detail,
    completedTicketJob,
    completedWorkerCodes,
    nextTicket,
    receiverAccountIds,
    assignmentStatus,
    isConfirmed,
    title: isConfirmed
      ? "Ticket completion confirmed"
      : "Ticket completion rejected",
    message: isConfirmed
      ? `Vendor confirmed ticket ${updated.ticket.boothCode}.`
      : `Vendor rejected ticket ${updated.ticket.boothCode}.`,
  };
}

/* -------------------------------------- Helpers -------------------------------------- */

// Function สร้าง key สำหรับระบุสินค้าแต่ละ package ภายใน ticket
function buildTicketProductKey(productCode: string, packageCode: string): string {
  return JSON.stringify([productCode, packageCode]);
}

// Function ตรวจ items ที่ส่งยอดให้ครบและไม่ซ้ำ (เปลี่ยน PackageCode ได้ แต่ห้ามเปลี่ยน ProductCode)
function validateTicketCompletionItems(
  products: TicketProductDto[],
  items: TicketProductConfirmationInput[],
): void {
  const productKeys = new Set(
    products.map((product) =>
      buildTicketProductKey(product.productCode, product.packageCode),
    ),
  );

  const matchedOriginalKeys = new Set<string>();
  const finalKeys = new Set<string>();

  for (const item of items) {
    const originalKey = buildTicketProductKey(
      item.productCode,
      item.original_package_code ?? item.packageCode,
    );

    if (!productKeys.has(originalKey)) {
      throw new ApiError(
        400,
        "INVALID_TICKET_PRODUCT",
        "Ticket product and package do not belong to this ticket.",
      );
    }

    if (matchedOriginalKeys.has(originalKey)) {
      throw new ApiError(
        400,
        "DUPLICATE_TICKET_PRODUCT",
        "Ticket product and package are duplicated in completion items.",
      );
    }

    matchedOriginalKeys.add(originalKey);

    const finalKey = buildTicketProductKey(item.productCode, item.packageCode);

    if (finalKeys.has(finalKey)) {
      throw new ApiError(
        400,
        "DUPLICATE_TICKET_PRODUCT",
        "Two ticket products cannot be switched to the same product and package.",
      );
    }

    finalKeys.add(finalKey);
  }

  if (matchedOriginalKeys.size !== products.length) {
    throw new ApiError(
      400,
      "INCOMPLETE_TICKET_PRODUCTS",
      "All ticket products must be sent with confirmed quantities.",
    );
  }
}

// Function หา Rate Snapshot ใหม่ให้ item ที่เปลี่ยน PackageCode (item ที่ไม่เปลี่ยนคืนค่าเดิม)
export async function resolvePackageSwitchesForItems(
  items: TicketProductConfirmationInput[],
  marketCode: string,
  connection: DbConnection,
): Promise<TicketProductConfirmationInput[]> {
  return Promise.all(
    items.map(async (item) => {
      const originalPackageCode = item.original_package_code;

      if (!originalPackageCode || originalPackageCode === item.packageCode) {
        return item;
      }

      const resolvedPackage = await rateResolutionService.resolvePackageWeight(
        item.productCode,
        item.packageCode,
        connection,
      );

      const packageWeight = resolvedPackage.packageWeight;
      const applicableRate = await rateResolutionService.requireApplicableRate(
        marketCode,
        packageWeight,
        connection,
      );
      const rateSnapshotAt = new Date();

      return {
        ...item,
        package_switch: {
          packageName: resolvedPackage.packageName,
          packageWeightSnapshot: packageWeight.toString(),
          rateIdSnapshot: applicableRate.rate.id,
          sourceRateIdSnapshot: applicableRate.rate.sourceRateId,
          rateMarketCode: applicableRate.appliedMarketCode,
          rateSource: applicableRate.rateSource,
          weightRangeName: applicableRate.rate.weightRangeName,
          weightMinSnapshot: applicableRate.rate.weightMin.toString(),
          weightMaxSnapshot: applicableRate.rate.weightMax.toString(),
          stallRateSnapshot: applicableRate.rate.stallRate.toString(),
          laborRateSnapshot: applicableRate.rate.laborRate.toString(),
          rateSnapshotAt,
        },
      };
    }),
  );
}

// Function เลือก timeout การยืนยัน vendor ตาม flow ส่งครั้งแรกหรือส่งใหม่หลัง reject
function getVendorConfirmationTimeoutMs(
  isResubmission: boolean,
  settings: Awaited<ReturnType<typeof getRuntimeSettings>>,
): number {
  const timeoutHours = isResubmission
    ? settings.vendor_reconfirm_timeout_hours
    : settings.vendor_confirm_timeout_hours;

  return timeoutHours * 60 * 60 * 1000;
}

// Function สร้าง postback token คู่ confirm/reject สำหรับ LINE ส่งหา Vendor
async function buildVendorCompletionPostbackData(
  ticket: BoothJobDto,
  submission: TicketCompletionSubmissionDto,
): Promise<{ confirm: string; reject: string }> {
  const confirmToken = await lineActionTokenRepository.createLineActionToken({
    action: "vendor_confirm_completion",
    ticket_id: ticket.id,
    submission_id: submission.id,
    boothCode: ticket.boothCode,
  });
  const rejectToken = await lineActionTokenRepository.createLineActionToken({
    action: "vendor_reject_completion",
    ticket_id: ticket.id,
    submission_id: submission.id,
    boothCode: ticket.boothCode,
  });

  return {
    confirm: `token=${confirmToken.token}`,
    reject: `token=${rejectToken.token}`,
  };
}

// Function สร้างข้อความ LINE ให้ Vendor ตรวจยอดที่ส่ง
function buildVendorCompletionMessages(
  ticket: BoothJobDto,
  postbackData: { confirm: string; reject: string },
  detail: TicketJobDetailResponse | null,
  products: TicketProductDto[],
  originalProducts: TicketProductDto[],
): LineMessage[] {
  return [
    buildVendorCompletionReviewFlexMessage({
      ticket,
      postbackData,
      detail,
      products,
      originalProducts,
    }),
  ];
}

/* -------------------------------------- Submission -------------------------------------- */

// Function ส่งยอดปิด Booth หนึ่งใบ ใช้ร่วมกันทั้ง Worker ส่งเองและ Admin ส่งแทน
export async function submitTicketCompletion(input: {
  findTicket: (connection: DbConnection) => Promise<BoothJobDto | null>;
  items: TicketProductConfirmationInput[];
  submittedByAccountId: number;
  submittedByRole: string;
  requireRosterMembership: boolean;
  connection: DbConnection;
}): Promise<{
  ticket: BoothJobDto;
  submission: TicketCompletionSubmissionDto;
  products: TicketProductDto[];
  originalProducts: TicketProductDto[];
  receiverAccountIds: number[];
  vendorLineTargets: VendorLineTargetDto[];
  vendorTimeoutMs: number;
}> {
  const {
    findTicket,
    items,
    submittedByAccountId,
    submittedByRole,
    requireRosterMembership,
    connection,
  } = input;
  const ticket = await findTicket(connection);

  if (!ticket) {
    throw new ApiError(404, "TICKET_NOT_FOUND", "Ticket not found.");
  }

  const vendorLineTargets =
    await boothJobRepository.listActiveVendorLineTargetsForTicket(
      ticket.id,
      connection,
    );

  if (vendorLineTargets.length === 0) {
    throw new ApiError(
      409,
      "TICKET_VENDOR_LINE_NOT_CONFIGURED",
      "Ticket vendor LINE targets are not configured.",
    );
  }

  if (ticket.status === TICKET_STATUS.COMPLETED) {
    throw new ApiError(409, "TICKET_ALREADY_CLOSED", "Ticket is already closed.");
  }

  const readiness = await ticketJobRepository.getVehicleWorkReadiness(
    ticket.vehicle_job_id,
    connection,
  );

  if (!readiness.is_ready) {
    throw new ApiError(
      409,
      "WORKERS_NOT_CHECKED_IN",
      "All assigned workers must check in before this stall job can be completed.",
      readiness,
    );
  }

  const ticketWorkers = await ticketJobLifecycleService.syncTicketWorkerRoster(
    ticket.market_job_id,
    ticket.vehicle_job_id,
    connection,
  );

  if (requireRosterMembership) {
    // Worker ต้องยังอยู่ใน roster ของ Business Ticket นี้ (อาจถูกถอดเฉพาะใบนี้)
    const isTicketWorker = ticketWorkers.some(
      (worker) =>
        worker.worker_id === submittedByAccountId &&
        worker.status === TICKET_WORKER_STATUS.WORKING,
    );

    if (!isTicketWorker) {
      throw new ApiError(
        403,
        "WORKER_NOT_IN_TICKET",
        "Worker is not assigned to this ticket.",
      );
    }
  }

  // Admin ส่งแทนได้เฉพาะแผงที่ Worker เคยส่ง และเงินรอบนี้หารให้กลุ่ม Worker ที่ส่งล่าสุด
  const isAdminSubmission = submittedByRole === TICKET_SUBMITTER_ROLE.ADMIN;
  const latestWorkerSubmission = isAdminSubmission
    ? await boothJobRepository.findLatestWorkerSubmissionSnapshot(ticket.id, connection)
    : null;

  if (isAdminSubmission && !latestWorkerSubmission) {
    throw new ApiError(
      409,
      "ADMIN_SUBMIT_REQUIRES_WORKER_SUBMISSION",
      "Admin can only submit on behalf of workers for a booth that a worker has already submitted.",
    );
  }

  const products = await boothJobRepository.listTicketProducts(
    ticket.id,
    connection,
  );

  validateTicketCompletionItems(products, items);

  const marketJob = await marketJobRepository.findMarketJobById(
    ticket.market_job_id,
    connection,
  );

  if (!marketJob) {
    throw new ApiError(404, "MARKET_JOB_NOT_FOUND", "Business ticket not found.");
  }

  // Resolve Rate ก่อน markTicketDelivered เพื่อให้ล้มก่อนเปลี่ยนสถานะถ้า PackageCode/Rate ไม่ถูกต้อง
  const resolvedItems = await resolvePackageSwitchesForItems(
    items,
    marketJob.marketCode,
    connection,
  );

  const canSubmit = await boothJobRepository.markTicketDelivered(
    ticket.id,
    connection,
  );

  if (!canSubmit) {
    if (ticket.status === TICKET_STATUS.DELIVERED) {
      throw new ApiError(
        409,
        "TICKET_ALREADY_SUBMITTED",
        "Ticket completion is already waiting for vendor confirmation.",
      );
    }

    throw new ApiError(
      409,
      "TICKET_NOT_READY_FOR_COMPLETION",
      "Ticket is not ready for completion submission.",
    );
  }

  // Worker ส่งเอง = roster WORKING ตอนนี้ / Admin ส่งแทน = กลุ่มจากรอบล่าสุดที่ Worker ส่ง
  const workingTicketWorkerIds =
    latestWorkerSubmission && latestWorkerSubmission.ticketWorkerIds.length > 0
      ? latestWorkerSubmission.ticketWorkerIds
      : ticketWorkers
          .filter((worker) => worker.status === TICKET_WORKER_STATUS.WORKING)
          .map((worker) => worker.id);
  const workerCountSnapshot = workingTicketWorkerIds.length;
  // Assignment ของผู้ส่ง (Admin ส่งแทนจะเป็น null)
  const submitterAssignment =
    await assignmentRepository.findCurrentAssignmentByTicketJobIdAndWorker(
      ticket.vehicle_job_id,
      submittedByAccountId,
      connection,
    );
  const submission = await boothJobRepository.createTicketCompletionSubmission(
    ticket.id,
    submittedByAccountId,
    submittedByRole,
    workerCountSnapshot,
    submitterAssignment?.id ?? null,
    connection,
  );

  // Snapshot นี้ใช้ทั้ง Work History และเป็นตัวหารเงินตอน Vendor confirm
  await boothJobRepository.createSubmissionWorkerSnapshots(
    submission.id,
    workingTicketWorkerIds,
    connection,
  );

  await assignmentRepository.setVehicleAssignmentsStatus(
    ticket.vehicle_job_id,
    ASSIGNMENT_STATUS.DELIVERED,
    connection,
  );

  const confirmedProducts = await boothJobRepository.updateTicketProductConfirmations(
    ticket.id,
    resolvedItems,
    connection,
  );
  const waitingTicket = await boothJobRepository.findBoothJobForCompletion(
    ticket.id,
    connection,
  );
  const receiverAccountIds = await resolveTicketResultAudience(ticket, connection);
  const settings = await getRuntimeSettings();

  return {
    ticket: waitingTicket ?? {
      ...ticket,
      status: TICKET_STATUS.DELIVERED,
      confirmation_status: TICKET_STATUS.DELIVERED,
    },
    submission,
    products: confirmedProducts,
    // ค่าก่อนอัปเดต ใช้เทียบ PackageCode เดิมกับใหม่ในข้อความ LINE
    originalProducts: products,
    receiverAccountIds,
    vendorLineTargets,
    vendorTimeoutMs: getVendorConfirmationTimeoutMs(
      ticket.status === TICKET_STATUS.REJECT,
      settings,
    ),
  };
}

// Function ตั้งเวลา auto-confirm, ส่ง LINE ให้ Vendor และแจ้ง realtime หลังส่งยอดสำเร็จ
export async function notifyTicketCompletionSubmitted(result: {
  ticket: BoothJobDto;
  submission: TicketCompletionSubmissionDto;
  products: TicketProductDto[];
  originalProducts: TicketProductDto[];
  receiverAccountIds: number[];
  vendorLineTargets: VendorLineTargetDto[];
  vendorTimeoutMs: number;
}): Promise<{ detail: TicketJobDetailResponse | null }> {
  await scheduleVendorConfirmationTimeout(
    result.ticket.id,
    result.submission.id,
    result.vendorTimeoutMs,
  );

  const detail = await ticketJobRepository.getTicketJobDetail(
    result.ticket.vehicle_job_id,
  );
  const linePostbackData = await buildVendorCompletionPostbackData(
    result.ticket,
    result.submission,
  );
  const lineMessages = buildVendorCompletionMessages(
    result.ticket,
    linePostbackData,
    detail,
    result.products,
    result.originalProducts,
  );

  for (const target of result.vendorLineTargets) {
    await enqueueLoggedLineMessage({
      jobName: "send-vendor-ticket-completion",
      action: "send_vendor_ticket_completion",
      targetLineUserId: target.line_user_id,
      payload: {
        ticket_id: result.ticket.id,
        submission_id: result.submission.id,
        vendor_line_id: target.line_user_id,
        vendor_line_target_type: target.target_type,
        items: result.products,
      },
      messages: lineMessages,
    });
  }

  const realtimePayload = {
    ...buildWorkerTicketPayload(result.ticket, detail, result.products, {
      submission_status: result.submission.status,
      assignment_status: ASSIGNMENT_STATUS.DELIVERED,
      confirmed_at: result.submission.confirmed_at,
      rejected_at: result.submission.rejected_at,
      ticket_completed_at: null,
    }),
  };

  publishRealtimeEvent({
    type: "TICKET_COMPLETION_SUBMITTED",
    title: "Ticket completion submitted",
    message: `Ticket ${result.ticket.boothCode} is waiting for vendor confirmation.`,
    payload: realtimePayload,
    admin: true,
    worker_ids: result.receiverAccountIds,
  });

  return { detail };
}

/* -------------------------------------- Recovery -------------------------------------- */

// Function กู้ Submission ที่ค้าง DELIVERED แต่ไม่มี timeout job (server ล่มหลัง commit) เรียกตอน server เริ่ม
export async function reconcileOrphanedTicketSubmissions(): Promise<number> {
  const candidates = await boothJobRepository.listDeliveredTicketsWithLatestSubmission();
  let reconciledCount = 0;

  for (const { ticket, submission, is_resubmission: isResubmission } of candidates) {
    const alreadyScheduled = await hasVendorConfirmationTimeout(ticket.id, submission.id);

    if (alreadyScheduled) {
      continue;
    }

    try {
      const [vendorLineTargets, products, receiverAccountIds, settings] = await Promise.all([
        boothJobRepository.listActiveVendorLineTargetsForTicket(ticket.id),
        boothJobRepository.listTicketProducts(ticket.id),
        resolveTicketResultAudience(ticket),
        getRuntimeSettings(),
      ]);

      if (vendorLineTargets.length === 0) {
        logger.warn("Skipped reconciling orphaned ticket submission: no vendor LINE target configured.", {
          ticketId: ticket.id,
          submissionId: submission.id,
        });
        continue;
      }

      // ไม่มี originalProducts จริงให้เทียบ จึงใช้ products ปัจจุบันทั้งสองฝั่ง
      await notifyTicketCompletionSubmitted({
        ticket,
        submission,
        products,
        originalProducts: products,
        receiverAccountIds,
        vendorLineTargets,
        // นับจากเวลาส่งยอดจริง ไม่เริ่มนับใหม่ทุกครั้งที่ restart
        vendorTimeoutMs: Math.max(
          0,
          Date.parse(submission.created_at) +
            getVendorConfirmationTimeoutMs(isResubmission, settings) -
            Date.now(),
        ),
      });
      reconciledCount += 1;
      logger.info("Reconciled an orphaned ticket submission stuck without a vendor-confirm-timeout job.", {
        ticketId: ticket.id,
        submissionId: submission.id,
      });
    } catch (error) {
      logger.error("Failed to reconcile orphaned ticket submission.", {
        ticketId: ticket.id,
        submissionId: submission.id,
        error,
      });
    }
  }

  return reconciledCount;
}
