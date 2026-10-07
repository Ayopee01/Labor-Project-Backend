// Import Library
import { Prisma } from "@prisma/client";
// Import Config
import { VEHICLE_JOB_STATUS, TICKET_WORKER_STATUS } from "../../constants/status";
// Import Repositories
import { client } from "./repository-utils";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function ดึงข้อมูลทุกแผง สินค้า และ roster ของ Business Ticket สำหรับปิดยอดเงิน
export async function findMarketJobFinancializationContext(
  marketJobId: number,
  connection?: DbConnection
) {
  const db = client(connection);

  return db.marketJob.findUnique({
    where: {
      id: marketJobId,
    },
    include: {
      tickets: {
        orderBy: {
          id: "asc",
        },
        include: {
          products: {
            orderBy: {
              id: "asc",
            },
            include: {
              // Include workerPayments ไว้ด้วยสำหรับตรวจ replay แบบ idempotent
              financial: {
                include: {
                  workerPayments: true,
                },
              },
            },
          },
          // Snapshot คนที่ส่งยอดรอบที่ถูกยืนยัน ใช้เป็นตัวหารเงินของแผงนี้
          workerSnapshots: {
            orderBy: {
              id: "asc",
            },
          },
        },
      },
      ticketWorkers: {
        orderBy: {
          id: "asc",
        },
        // ใช้ laborColor ตอนปิดยอดเพื่อบันทึก shirt_color_snapshot (สีเสื้อแก้ทีหลังได้)
        include: {
          worker: true,
        },
      },
    },
  });
}

// Function lock roster ของ Business Ticket แบบ idempotent (หลัง lock ห้ามแก้ roster อีก)
export async function lockMarketJobWorkerRoster(
  marketJobId: number,
  connection?: DbConnection
): Promise<void> {
  const db = client(connection);

  await db.marketJob.updateMany({
    where: {
      id: marketJobId,
      workerRosterLockedAt: null,
    },
    data: {
      workerRosterLockedAt: new Date(),
    },
  });
}

// Function ปิด roster โดยเปลี่ยน worker ที่ยัง WORKING เป็น COMPLETED (แถวที่ CANCELLED ไม่ถูกแตะ)
export async function markMarketJobTicketWorkersCompleted(
  marketJobId: number,
  completedAt: Date,
  connection?: DbConnection
): Promise<void> {
  const db = client(connection);

  await db.ticketWorker.updateMany({
    where: {
      marketJobId,
      status: TICKET_WORKER_STATUS.WORKING,
    },
    data: {
      status: TICKET_WORKER_STATUS.COMPLETED,
      completedAt,
      cancelledAt: null,
    },
  });
}

// Function บันทึกผลคำนวณการเงินของสินค้าหนึ่งชิ้นในตั๋ว พร้อมยอดจ่ายรายคนของ worker (workerPayments)
export async function createTicketProductFinancial(
  input: {
    ticketProductId: number;
    confirmedQuantity: Prisma.Decimal;
    workerCount: number;
    workerPayoutTotal: Prisma.Decimal;
    fundAmount: Prisma.Decimal;
    finalizedAt: Date;
    shirtColorSnapshot: string;
    workerPayments: Array<{
      ticketWorkerId: number;
      rawAmount: Prisma.Decimal;
      remainderAmount: Prisma.Decimal;
      finalAmount: Prisma.Decimal;
    }>;
  },
  connection?: DbConnection
) {
  const db = client(connection);

  return db.ticketProductFinancial.create({
    data: {
      ticketProductId: input.ticketProductId,
      confirmedQuantity: input.confirmedQuantity,
      workerCount: input.workerCount,
      workerPayoutTotal: input.workerPayoutTotal,
      fundAmount: input.fundAmount,
      finalizedAt: input.finalizedAt,
      shirtColorSnapshot: input.shirtColorSnapshot,
      workerPayments: {
        create:
          input.workerPayments.map(
            (payment) => ({
              ticketWorkerId: payment.ticketWorkerId,
              rawAmount: payment.rawAmount,
              remainderAmount: payment.remainderAmount,
              finalAmount: payment.finalAmount,
            })
          ),
      },
    },
  });
}

// Function อัปเดต final_earning_amount ของ ticket worker หลายคนพร้อมกัน (วนอัปเดตทีละคน)
export async function updateTicketWorkerFinalEarningAmounts(
  amountsByTicketWorkerId: Map<number, Prisma.Decimal>,
  connection?: DbConnection
): Promise<void> {
  const db = client(connection);

  for (const [ticketWorkerId, finalEarningAmount] of amountsByTicketWorkerId) {
    await db.ticketWorker.update({
      where: {
        id: ticketWorkerId,
      },
      data: {
        finalEarningAmount,
      },
    });
  }
}

// Function ดึงสินค้าของแผงสำหรับคิดยอดแผงตอน Vendor ยืนยัน
export async function listBoothStallChargeProducts(
  ticketId: number,
  connection?: DbConnection
) {
  const db = client(connection);

  return db.ticketProduct.findMany({
    where: {
      ticketId,
    },
    orderBy: {
      id: "asc",
    },
  });
}

// Function บันทึกยอดแผงรายสินค้า (คิดตอน Vendor ยืนยัน)
export async function updateTicketProductStallCharge(
  ticketProductId: number,
  input: {
    stallFeeRaw: Prisma.Decimal;
    stallFeeRounded: Prisma.Decimal;
    laborFeeRaw: Prisma.Decimal;
    productCharge: Prisma.Decimal;
  },
  connection?: DbConnection
): Promise<void> {
  const db = client(connection);

  await db.ticketProduct.update({
    where: {
      id: ticketProductId,
    },
    data: {
      stallFeeRaw: input.stallFeeRaw,
      stallFeeRounded: input.stallFeeRounded,
      laborFeeRaw: input.laborFeeRaw,
      productCharge: input.productCharge,
    },
  });
}

// Function บันทึกยอดรวมที่แผงต้องจ่าย (คิดตอน Vendor ยืนยัน)
export async function updateBoothJobFinalStallAmount(
  ticketId: number,
  finalStallAmount: Prisma.Decimal,
  connection?: DbConnection
): Promise<void> {
  const db = client(connection);

  await db.boothJob.update({
    where: {
      id: ticketId,
    },
    data: {
      finalStallAmount,
    },
  });
}

// Function บันทึกเวลาปิดยอดของแผง (ยอดแผงบันทึกไว้แล้วตั้งแต่ตอน Vendor ยืนยัน)
export async function markBoothJobFinancialized(
  ticketId: number,
  finalizedAt: Date,
  connection?: DbConnection
): Promise<void> {
  const db = client(connection);

  await db.boothJob.update({
    where: {
      id: ticketId,
    },
    data: {
      financializedAt: finalizedAt,
    },
  });
}

// Function บันทึกผล Finalize การเงินของ Business Ticket ทั้งใบแบบ idempotent (guard หลัก)
export async function markMarketJobFinancialized(
  marketJobId: number,
  finalStallAmount: Prisma.Decimal,
  finalizedAt: Date,
  connection?: DbConnection
): Promise<void> {
  const db = client(connection);
  const result = await db.marketJob.updateMany({
    where: {
      id: marketJobId,
      financializedAt: null,
    },
    data: {
      finalStallAmount,
      financializedAt: finalizedAt,
      completedAt: finalizedAt,
      status: VEHICLE_JOB_STATUS.COMPLETED,
    },
  });

  if (result.count !== 1) {
    throw new Error(
      "Market job financialization did not update exactly one market job."
    );
  }
}
