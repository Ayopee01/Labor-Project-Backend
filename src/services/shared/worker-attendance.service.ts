// Import Queues
import { getWorkerBreakCount, scheduleWorkerShiftEnd } from "../../queues/worker-queue";
// Import Repositories
import * as assignmentRepository from "../../repositories/shared/ticket-job-assignment.repository";
import * as workerBreakLogRepository from "../../repositories/shared/worker-break-log.repository";
import * as workerCheckinLogRepository from "../../repositories/shared/worker-checkin-log.repository";
// Import Types
import type { MasterWorkerDto, WorkScheduleDto } from "../../types/admin-workers.type";
import type { DbConnection } from "../../types/shared/common.type";
import type { WorkerBreakEndReason, WorkerShiftCloseReason, WorkerStatusResponse } from "../../types/worker.type";
// Import Utils
import { buildWorkScheduleShiftInstanceKey, getWorkScheduleShiftEndDelayMs } from "../../utils/shift";
import { buildBangkokDateRange, formatBangkokDate } from "../../utils/time";

/* -------------------------------------- Functions -------------------------------------- */

// Function รวมยอดงานวันนี้ จำนวนพัก และจำนวนงานที่จบแล้วของ Worker
export async function buildWorkerDailySummary(
  accountId: number,
  schedule: WorkScheduleDto | null,
  connection?: Parameters<
    typeof assignmentRepository.getWorkerDailyAssignmentCounts
  >[3],
): Promise<
  Pick<
    WorkerStatusResponse,
    "today_job_count" | "break_count_used" | "completed_job_count"
  >
> {
  const today = formatBangkokDate();
  const { startAt, endAt } = buildBangkokDateRange(today);
  const shiftInstanceKey = schedule
    ? buildWorkScheduleShiftInstanceKey(schedule)
    : null;
  const [assignmentCounts, breakCountUsed] = await Promise.all([
    assignmentRepository.getWorkerDailyAssignmentCounts(
      accountId,
      startAt,
      endAt,
      connection,
    ),
    shiftInstanceKey ? getWorkerBreakCount(accountId, shiftInstanceKey) : 0,
  ]);

  return {
    today_job_count: assignmentCounts.today_job_count,
    break_count_used: breakCountUsed,
    completed_job_count: assignmentCounts.completed_job_count,
  };
}

// Function ตั้ง job ปิดกะ worker เมื่อเวลาสิ้นสุดกะยังอยู่ในอนาคต
export async function scheduleWorkerShiftEndIfNeeded(
  accountId: number,
  schedule: WorkScheduleDto,
): Promise<void> {
  const delayMs = getWorkScheduleShiftEndDelayMs(schedule);

  if (delayMs > 0) {
    await scheduleWorkerShiftEnd(
      accountId,
      schedule.id,
      delayMs,
      buildWorkScheduleShiftInstanceKey(schedule),
    );
  }
}

// Function บันทึกว่า worker online แล้วในกะปัจจุบัน
export async function markWorkerAttendanceOnline(
  worker: MasterWorkerDto,
  schedule: WorkScheduleDto,
  shiftInstanceKey: string,
  connection?: DbConnection,
): Promise<void> {
  await workerCheckinLogRepository.markWorkerShiftOnline(
    {
      worker_id: worker.id,
      worker_code: worker.labor_code,
      schedule,
      shift_instance_key: shiftInstanceKey,
    },
    connection,
  );
}

// Function เปิด attendance ของกะที่ถูกปิดไปแล้วกลับมา — ใช้ตอน Admin force Worker กลับเข้าคิว (READY/BREAK)
export async function reopenWorkerAttendanceShift(
  worker: MasterWorkerDto,
  schedule: WorkScheduleDto,
  shiftInstanceKey: string,
  connection?: DbConnection,
): Promise<void> {
  await workerCheckinLogRepository.reopenWorkerShift(
    {
      worker_id: worker.id,
      worker_code: worker.labor_code,
      schedule,
      shift_instance_key: shiftInstanceKey,
    },
    connection,
  );
}

// Function ปิด attendance ของกะ worker พร้อมเหตุผลที่ออกจากกะ
export async function closeWorkerAttendanceShift(
  worker: MasterWorkerDto,
  schedule: WorkScheduleDto,
  shiftInstanceKey: string,
  reason: WorkerShiftCloseReason,
  connection?: DbConnection,
): Promise<void> {
  await workerCheckinLogRepository.closeWorkerShift(
    {
      worker_id: worker.id,
      worker_code: worker.labor_code,
      schedule,
      shift_instance_key: shiftInstanceKey,
      reason,
    },
    connection,
  );
}

// Function เริ่มบันทึก break log หนึ่งครั้งของ worker ในกะปัจจุบัน
export async function startWorkerBreakLog(
  workerId: number,
  shiftInstanceKey: string,
  scheduledEndAt: Date,
  connection?: DbConnection,
): Promise<void> {
  await workerBreakLogRepository.createBreakLog(
    {
      worker_id: workerId,
      shift_instance_key: shiftInstanceKey,
      scheduled_end_at: scheduledEndAt,
    },
    connection,
  );
}

// Function ปิด break log ที่ยังเปิดอยู่ล่าสุดของ worker ในกะปัจจุบัน
export async function closeWorkerBreakLog(
  workerId: number,
  shiftInstanceKey: string,
  endReason: WorkerBreakEndReason,
  connection?: DbConnection,
): Promise<void> {
  await workerBreakLogRepository.closeOpenBreakLog(
    {
      worker_id: workerId,
      shift_instance_key: shiftInstanceKey,
      end_reason: endReason,
    },
    connection,
  );
}
