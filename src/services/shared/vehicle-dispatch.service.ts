// Import Config
import { withTransaction } from "../../db/prisma";
import { TERMINAL_JOB_STATUSES, VEHICLE_JOB_STATUS } from "../../constants/status";
// Import Repositories
import * as adminActionLogRepository from "../../repositories/shared/admin-action-log.repository";
import * as boothJobRepository from "../../repositories/shared/booth-job.repository";
import * as marketJobRepository from "../../repositories/shared/market-job.repository";
import * as profileRepository from "../../repositories/shared/profile.repository";
import * as ticketJobRepository from "../../repositories/shared/ticket-job.repository";
// Import Services
import { publishDriverJobUpdate } from "../driver-stream.service";
import { publishRealtimeEvent } from "./realtime-notification.service";
import * as ticketJobLifecycleService from "./ticket-job-lifecycle.service";
import { notifyVendorBoothDispatchResumed, notifyVendorBoothWait } from "./vendor-line-notification.service";
// Import Queues
import { dispatchReadyWorkers, requeueWorkersAtFrontRespectingShift, sortAssignmentsByAcceptedAt } from "../../queues/worker-dispatch";
// Import Websockets
import { sendWorkerSocketEvent } from "../../websockets/worker.socket";
// Import Types
import { ADMIN_ACTION_TYPE } from "../../types/shared/admin-action-log.type";
import type { ChangeTicketJobDispatchInput, ChangeTicketJobDispatchResult, VehicleDispatchActor } from "../../types/shared/vehicle-dispatch.type";
import { WORKER_WORK_STATUS } from "../../types/shared/worker-status.type";
import type { TicketJobAssignmentDto, TicketJobDto } from "../../types/worker.type";
// Import Utils
import ApiError from "../../utils/api-error";
import { logger } from "../../utils/logger";

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจว่างานรถอยู่ในสถานะ dispatch ตามที่ขออยู่แล้ว (สั่งซ้ำไม่ต้องทำอะไร)
function isTicketJobAlreadyInDispatchState(
  ticketJob: TicketJobDto,
  dispatch: boolean,
): boolean {
  const targetStatus = dispatch ? VEHICLE_JOB_STATUS.WORKING : VEHICLE_JOB_STATUS.WAIT;

  return ticketJob.dispatch_now === dispatch && ticketJob.status === targetStatus;
}

// Function สร้างข้อความแจ้ง Admin realtime ตามผู้สั่งและทิศทางของ dispatch
function buildDispatchRealtimeEvent(
  actor: VehicleDispatchActor,
  dispatch: boolean,
  ticketNumber: string,
): { type: string; title: string; message: string } {
  if (actor.type === "driver") {
    return dispatch
      ? {
          type: "DRIVER_JOB_READY",
          title: "Driver job ready",
          message: `Driver marked vehicle job ${ticketNumber} ready.`,
        }
      : {
          type: "DRIVER_JOB_WAIT",
          title: "Driver job set to wait",
          message: `Driver set vehicle job ${ticketNumber} back to wait.`,
        };
  }

  return {
    type: "VEHICLE_JOB_WAIT",
    title: dispatch ? "Vehicle job dispatch re-enabled" : "Vehicle job set to wait",
    message: dispatch
      ? `Vehicle job ${ticketNumber} was dispatched again by admin.`
      : `Vehicle job ${ticketNumber} was set back to wait by admin.`,
  };
}

// Function คืนทีมที่ถูกยกเลิกเข้าหน้าคิว (หมดกะไป open_app) แล้วแจ้ง Worker ทุกคน
async function requeueCancelledTeam(
  ticketJob: TicketJobDto,
  cancelledAssignments: TicketJobAssignmentDto[],
  input: ChangeTicketJobDispatchInput,
): Promise<{ workerToQueue: Array<string | null>; workerToOpenApp: Array<string | null> }> {
  const candidateWorkerIds = sortAssignmentsByAcceptedAt(cancelledAssignments).map(
    (assignment) => assignment.worker_id,
  );

  // เช็คกะสดก่อนคืนเข้าคิวเสมอ — Worker ที่หมดกะไปแล้วต้องไป open_app ไม่ใช่ถูกดันกลับเข้า READY
  const { requeuedWorkerIds, openAppWorkerIds } =
    await requeueWorkersAtFrontRespectingShift(candidateWorkerIds);

  // ส่ง ASSIGNMENT_CANCELLED (มี push) คู่กับ WORKER_STATUS_CHANGED ให้แอปที่ปิดอยู่รู้ด้วย
  const ticketNos = await marketJobRepository.listActiveTicketNosByTicketJobId(
    ticketJob.id,
  );
  const notifyAssignmentCancelledByWait = (
    workerId: number,
    workerStatus: string,
    reason: string,
  ) => {
    sendWorkerSocketEvent(workerId, "WORKER_STATUS_CHANGED", {
      status: workerStatus,
      reason,
    });
    sendWorkerSocketEvent(workerId, "ASSIGNMENT_CANCELLED", {
      ticketNumber: ticketJob.ticket_number,
      ticketNos,
      reason,
      worker_status: workerStatus,
      reason_code: input.reason_code,
      reason_text: input.reason_text,
    });
  };

  for (const workerId of requeuedWorkerIds) {
    notifyAssignmentCancelledByWait(
      workerId,
      WORKER_WORK_STATUS.READY,
      "vehicle_job_wait_requeue",
    );
  }
  for (const workerId of openAppWorkerIds) {
    notifyAssignmentCancelledByWait(
      workerId,
      WORKER_WORK_STATUS.OPEN_APP,
      "vehicle_job_wait_shift_ended",
    );
  }

  const [workerToQueue, workerToOpenApp] = await Promise.all([
    profileRepository.findWorkerCodesByAccountIds(requeuedWorkerIds),
    profileRepository.findWorkerCodesByAccountIds(openAppWorkerIds),
  ]);

  return { workerToQueue, workerToOpenApp };
}

// Function เปิด/ปิด dispatch ของงานรถ (ปิด = คืนทีมเข้าหน้าคิว) ใช้ร่วมกันระหว่าง Admin และ Driver
export async function changeTicketJobDispatch(
  input: ChangeTicketJobDispatchInput,
): Promise<ChangeTicketJobDispatchResult> {
  const { actor, dispatch } = input;
  const ticketJobId = input.ticket_job.id;

  const transactionResult = await withTransaction(async (transaction) => {
    // lock รถแล้วอ่านสถานะใหม่ กัน race กับ Worker ที่กำลัง scan/ส่งยอด และ Admin ที่ยกเลิกรถพร้อมกัน
    await transaction.$queryRaw`SELECT id FROM ticket_jobs WHERE id = ${ticketJobId} FOR UPDATE`;

    const currentTicketJob = await ticketJobRepository.findTicketJobById(
      ticketJobId,
      transaction,
    );

    if (!currentTicketJob || TERMINAL_JOB_STATUSES.includes(currentTicketJob.status)) {
      throw new ApiError(
        409,
        "VEHICLE_JOB_CLOSED",
        "Vehicle job is already closed and cannot change dispatch.",
      );
    }

    // ปล่อยทีมกลับคิวไปแล้ว = ส่งยอดครบทุกแผงแล้ว ทั้ง Admin และ Driver ห้ามเปิด/ปิด dispatch อีก
    if (currentTicketJob.status === VEHICLE_JOB_STATUS.RELEASED) {
      throw new ApiError(
        409,
        "VEHICLE_JOB_RELEASED",
        "Vehicle job workers were already released; dispatch can no longer be changed.",
      );
    }

    const hasSubmission =
      await ticketJobRepository.hasTicketCompletionSubmissionForTicketJob(
        ticketJobId,
        transaction,
      );

    if (hasSubmission) {
      throw new ApiError(
        409,
        "VEHICLE_JOB_ALREADY_SUBMITTED",
        "A booth on this vehicle job has already been submitted; dispatch can no longer be changed.",
      );
    }

    // สั่งซ้ำสถานะเดิม ไม่เขียน log และไม่แจ้งใครซ้ำ (เช็คหลังด่านปิดงาน/ส่งยอด งานที่ล็อกแล้วจึงได้ 409 เสมอ)
    if (isTicketJobAlreadyInDispatchState(currentTicketJob, dispatch)) {
      return { changed: false as const, ticketJob: currentTicketJob };
    }

    const cancelledAssignments = dispatch
      ? []
      : await ticketJobLifecycleService.cancelActiveAssignmentsForTicketJob(
          ticketJobId,
          `${actor.type}_vehicle_job_wait`,
          transaction,
        );
    const updatedTicketJob = await ticketJobRepository.setTicketJobDispatch(
      ticketJobId,
      dispatch,
      transaction,
    );

    await adminActionLogRepository.create(
      {
        vehicle_job_id: ticketJobId,
        action_type: ADMIN_ACTION_TYPE.VEHICLE_WAIT,
        reason_code: input.reason_code,
        reason_text: input.reason_text,
        actor_account_id: actor.type === "admin" ? actor.account_id : null,
        metadata: {
          dispatch,
          source: actor.type,
          ...(actor.type === "driver" && { driver_session_id: actor.driver_session_id }),
          worker_ids: cancelledAssignments.map((assignment) => assignment.worker_id),
        },
      },
      transaction,
    );

    return {
      changed: true as const,
      ticketJob: updatedTicketJob,
      cancelledAssignments,
    };
  });

  if (!transactionResult.changed) {
    return {
      changed: false,
      ticket_job: transactionResult.ticketJob,
      worker_to_queue: [],
      worker_to_openapp: [],
    };
  }

  const { ticketJob, cancelledAssignments } = transactionResult;

  // แจ้ง Driver Web ว่า dispatch/สถานะรถเปลี่ยน — เรียกหลัง transaction ข้างบน commit สำเร็จแล้วเท่านั้น
  publishDriverJobUpdate(ticketJobId, "DRIVER_JOB_UPDATED");

  let workerToQueue: Array<string | null> = [];
  let workerToOpenApp: Array<string | null> = [];

  if (cancelledAssignments.length > 0) {
    ({ workerToQueue, workerToOpenApp } = await requeueCancelledTeam(
      ticketJob,
      cancelledAssignments,
      input,
    ));
  }

  // เปิด dispatch = หาคนให้รถคันนี้, ปิด dispatch = ให้ทีมที่กลับเข้าคิวไปรับงานคันอื่น (best-effort)
  if (dispatch || workerToQueue.length > 0) {
    try {
      await dispatchReadyWorkers();
    } catch (error) {
      logger.error("Vehicle job dispatch changed but worker dispatch failed.", {
        ticketJobId,
        ticketNumber: ticketJob.ticket_number,
        dispatch,
        actorType: actor.type,
        error,
      });
    }
  }

  const realtimeEvent = buildDispatchRealtimeEvent(actor, dispatch, ticketJob.ticket_number);

  publishRealtimeEvent({
    ...realtimeEvent,
    payload: {
      ticketNumber: ticketJob.ticket_number,
      license_plate: ticketJob.license_plate,
      license_plate_province: ticketJob.license_plate_province,
      dispatch_now: ticketJob.dispatch_now,
      status: ticketJob.status,
      actor_type: actor.type,
      reason_code: input.reason_code,
      worker_to_queue: workerToQueue,
      worker_to_openapp: workerToOpenApp,
    },
    admin: true,
  });

  const activeBooths = await boothJobRepository.listActiveBoothsByTicketJobId(ticketJobId);

  for (const booth of activeBooths) {
    const notifyInput = {
      ticketId: booth.id,
      ticketNo: booth.ticketNo,
      marketName: booth.marketName,
      boothCode: booth.boothCode,
      boothName: booth.boothName,
      licensePlate: ticketJob.license_plate,
    };

    if (dispatch) {
      await notifyVendorBoothDispatchResumed(notifyInput);
    } else {
      await notifyVendorBoothWait(notifyInput);
    }
  }

  return {
    changed: true,
    ticket_job: ticketJob,
    worker_to_queue: workerToQueue,
    worker_to_openapp: workerToOpenApp,
  };
}
