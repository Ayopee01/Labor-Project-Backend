// Import Library
import { Prisma } from "@prisma/client";
// Import Utils
import { client } from "./repository-utils";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";
import type { WorkerAssignmentEventWriteInput } from "../../types/shared/worker-assignment-event.type";

// Function บันทึก assignment event แบบ idempotent — ถ้าซ้ำ (unique constraint P2002) จะเงียบไว้ ไม่ throw
export async function createOnce(
  input: WorkerAssignmentEventWriteInput,
  connection?: DbConnection,
): Promise<void> {
  const db = client(connection);

  // ใช้ ON CONFLICT DO NOTHING (skipDuplicates) แทนการ catch P2002 — ใน Postgres ถ้า unique violation เกิดใน
  // transaction จะ abort ทั้ง transaction ทันที (query ถัดไป fail ด้วย 25P02) การ catch แล้ว return เงียบๆ
  // จึงกันซ้ำไม่ได้จริงเมื่อถูกเรียกใน transaction ซึ่งเป็นกรณีส่วนใหญ่ของ caller
  await db.workerAssignmentEvent.createMany({
    data: [
      {
        assignmentId: input.assignment_id,
        workerId: input.worker_id,
        ticketJobId: input.vehicle_job_id,
        eventType: input.event_type,
        occurredAt: input.occurred_at ?? new Date(),
        metadata: input.metadata
          ? (input.metadata as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      },
    ],
    skipDuplicates: true,
  });
}

// Function บันทึก assignment event หลายรายการแบบ idempotent (เรียก createOnce วนทีละรายการ)
export async function createManyOnce(
  inputs: WorkerAssignmentEventWriteInput[],
  connection?: DbConnection,
): Promise<void> {
  for (const input of inputs) {
    await createOnce(input, connection);
  }
}

// Function อ่าน metadata ของ WorkerAssignmentEvent ที่เคยบันทึกไว้
export async function findMetadataByAssignmentAndType(
  assignmentId: number,
  eventType: string,
  connection?: DbConnection,
): Promise<Record<string, unknown> | null> {
  const db = client(connection);
  const event = await db.workerAssignmentEvent.findUnique({
    where: {
      assignmentId_eventType: {
        assignmentId,
        eventType,
      },
    },
  });

  return (event?.metadata as Record<string, unknown> | null | undefined) ?? null;
}
