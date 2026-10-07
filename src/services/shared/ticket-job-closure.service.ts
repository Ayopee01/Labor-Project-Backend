// Import Services
import { publishRealtimeEvent } from "./realtime-notification.service";
// Import Queues
import { removeAssignmentTimeout, removeScanTimeout, removeScanWarning } from "../../queues/worker-queue";
import { returnCompletedWorkersToQueue } from "../../queues/worker-dispatch";
// Import Types
import type { CompletedTicketJobResult } from "../../types/worker.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function ล้าง timer และคืน worker เข้าคิวเมื่อรถปิดงานจากการยกเลิก Business Ticket/แผง (null = ไม่ทำอะไร)
export async function handleTicketJobClosedByCascadeCancellation(
  result: CompletedTicketJobResult | null,
): Promise<void> {
  if (!result) {
    return;
  }

  await Promise.all(
    [
      ...result.completed_assignment_ids,
      ...result.closed_before_scan_assignment_ids,
      ...result.cancelled_assignment_ids,
    ].flatMap((assignmentId) => [
      removeAssignmentTimeout(assignmentId),
      removeScanTimeout(assignmentId),
      removeScanWarning(assignmentId),
    ]),
  );

  await returnCompletedWorkersToQueue(result);

  publishRealtimeEvent({
    type: "VEHICLE_JOB_CLOSED",
    title: "Vehicle job closed",
    message: `Vehicle job ${result.vehicle_job.ticket_number} closed as ${result.vehicle_job.status} after a market/booth cancellation.`,
    payload: {
      ticketNumber: result.vehicle_job.ticket_number,
      status: result.vehicle_job.status,
    },
    worker_payload: {
      ticketNumber: result.vehicle_job.ticket_number,
      status: result.vehicle_job.status,
    },
    admin: true,
    worker_ids: [...result.completed_worker_ids, ...result.cancelled_worker_ids],
  });
}
