// Import Library
import { Prisma } from "@prisma/client";
// Import Config
import { SHIRT_COLOR_SNAPSHOT, TICKET_STATUS, TICKET_WORKER_STATUS, TERMINAL_TICKET_STATUSES } from "../../constants/status";
// Import Repositories
import * as ticketFinancialRepository from "../../repositories/shared/ticket-financial.repository";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";
import type { TicketFinancializationResult } from "../../types/shared/ticket-financial.type";
// Import Utils
import ApiError from "../../utils/api-error";
import { calculateProductStallCharge, calculateProductWorkerPayment } from "../../utils/labor-job-pricing";

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจสอบว่า Product มี Rate Snapshot ที่จำเป็นสำหรับ Financialization ครบหรือไม่
function hasCompleteRateSnapshot(product: {
  packageWeightSnapshot: Prisma.Decimal | null;

  rateIdSnapshot: number | null;

  sourceRateIdSnapshot: number | null;

  rateMarketCode: string | null;

  rateSource: string | null;

  weightRangeName: string | null;

  weightMinSnapshot: Prisma.Decimal | null;

  weightMaxSnapshot: Prisma.Decimal | null;

  stallRateSnapshot: Prisma.Decimal | null;

  laborRateSnapshot: Prisma.Decimal | null;

  rateSnapshotAt: Date | null;
}): boolean {
  return (
    product.packageWeightSnapshot !== null &&
    product.rateIdSnapshot !== null &&
    product.sourceRateIdSnapshot !== null &&
    product.rateMarketCode !== null &&
    product.rateSource !== null &&
    product.weightRangeName !== null &&
    product.weightMinSnapshot !== null &&
    product.weightMaxSnapshot !== null &&
    product.stallRateSnapshot !== null &&
    product.laborRateSnapshot !== null &&
    product.rateSnapshotAt !== null
  );
}

// Function หาสีเสื้อของกลุ่ม worker ที่หารเงิน (สีเดียวกัน = สีนั้น, ต่างกัน = MIXED, ไม่มีค่า = UNKNOWN)
function resolveShirtColorSnapshot(
  boothWorkers: Array<{ worker: { laborColor: string | null } }>,
): string {
  const distinctColors = new Set(boothWorkers.map((worker) => worker.worker.laborColor));

  if (distinctColors.size !== 1) {
    return SHIRT_COLOR_SNAPSHOT.MIXED;
  }

  const [color] = distinctColors;

  return color ?? SHIRT_COLOR_SNAPSHOT.UNKNOWN;
}

// Function ปิดยอดเงินของ Business Ticket ทั้งใบ (ทุกแผงต้องจบ และหารเงินตาม snapshot ของแต่ละแผง)
export async function finalizeMarketJobFinancials(
  marketJobId: number,
  connection?: DbConnection,
): Promise<TicketFinancializationResult> {
  const context =
    await ticketFinancialRepository.findMarketJobFinancializationContext(
      marketJobId,
      connection,
    );

  if (!context) {
    throw new ApiError(
      404,
      "MARKET_JOB_NOT_FOUND",
      "Business ticket not found for financialization.",
    );
  }

  // Idempotent: ถ้า Financialize แล้วให้คืนค่าเดิม ห้ามคำนวณหรือสร้างรายการใหม่
  if (context.financializedAt) {
    if (context.finalStallAmount === null) {
      throw new ApiError(
        500,
        "TICKET_FINANCIAL_STATE_INVALID",
        "Financialized business ticket does not have final stall amount.",
      );
    }

    const completedWorkers = context.ticketWorkers.filter(
      (worker) => worker.status === TICKET_WORKER_STATUS.COMPLETED,
    );
    const hasMissingWorkerEarning = completedWorkers.some(
      (worker) => worker.finalEarningAmount === null,
    );

    if (hasMissingWorkerEarning) {
      throw new ApiError(
        500,
        "TICKET_FINANCIAL_STATE_INVALID",
        "Financialized business ticket has completed worker without final earning amount.",
      );
    }

    const financializedProductCount = context.tickets.reduce(
      (total, ticket) => total + ticket.products.length,
      0,
    );
    // นับ worker ที่ได้เงินจาก workerPayments (finalEarningAmount ถูกตั้งเป็น 0 ให้ทุกคนจึงใช้นับไม่ได้)
    const paidWorkerIds = new Set<number>();

    for (const ticket of context.tickets) {
      for (const product of ticket.products) {
        for (const payment of product.financial?.workerPayments ?? []) {
          paidWorkerIds.add(payment.ticketWorkerId);
        }
      }
    }

    return {
      marketJobId: context.id,

      productCount: financializedProductCount,

      workerCount: paidWorkerIds.size,

      finalStallAmount: context.finalStallAmount,

      finalizedAt: context.financializedAt,

      alreadyFinalized: true,
    };
  }

  const completedTickets = context.tickets.filter(
    (ticket) => ticket.status === TICKET_STATUS.COMPLETED,
  );
  const allTicketsTerminal =
    context.tickets.length > 0 &&
    context.tickets.every((ticket) => TERMINAL_TICKET_STATUSES.includes(ticket.status));

  if (completedTickets.length === 0 || !allTicketsTerminal) {
    throw new ApiError(
      409,
      "MARKET_JOB_NOT_READY_FOR_FINANCIALIZE",
      "Every booth of this business ticket must be terminal, with at least one completed, before financialization.",
    );
  }

  const products = completedTickets.flatMap((ticket) => ticket.products);

  if (products.length === 0) {
    throw new ApiError(
      409,
      "TICKET_PRODUCTS_NOT_FOUND",
      "Business ticket does not have products for financialization.",
    );
  }

  // มี Product Financial อยู่แล้วทั้งที่ยังไม่ปิดยอด = ข้อมูลค้างครึ่งทาง ห้ามเขียนทับ
  const hasExistingFinancial = products.some(
    (product) => product.financial !== null,
  );

  if (hasExistingFinancial) {
    throw new ApiError(
      500,
      "TICKET_FINANCIAL_PARTIAL_STATE",
      "Business ticket has partial financial records before finalization.",
    );
  }

  // roster ที่ยัง WORKING ใช้เป็น fallback ของแผงที่ไม่มี snapshot เท่านั้น
  const workingWorkers = context.ticketWorkers.filter(
    (worker) => worker.status === TICKET_WORKER_STATUS.WORKING,
  );
  // roster ไม่เหลือ WORKING ก็ปิดยอดได้ ถ้าทุกแผงที่ COMPLETED มี snapshot
  const everyCompletedBoothHasSnapshot = completedTickets.every(
    (ticket) => ticket.workerSnapshots.length > 0,
  );

  if (workingWorkers.length <= 0 && !everyCompletedBoothHasSnapshot) {
    throw new ApiError(
      409,
      "TICKET_WORKERS_NOT_FOUND",
      "Business ticket does not have active workers for financialization.",
    );
  }

  const finalizedAt = new Date();

  // lock roster ก่อนคำนวณเสมอ เพื่อไม่ให้แก้ roster ได้อีก
  await ticketFinancialRepository.lockMarketJobWorkerRoster(
    context.id,
    connection,
  );
  await ticketFinancialRepository.markMarketJobTicketWorkersCompleted(
    context.id,
    finalizedAt,
    connection,
  );

  let finalStallAmount = new Prisma.Decimal(0);

  const finalEarningByTicketWorkerId = new Map<number, Prisma.Decimal>();
  const boothStallAmountByTicketId = new Map<number, Prisma.Decimal>();
  const distinctPaidWorkerIds = new Set<number>();
  const ticketWorkerById = new Map(
    context.ticketWorkers.map((worker) => [worker.id, worker]),
  );

  for (const worker of workingWorkers) {
    finalEarningByTicketWorkerId.set(worker.id, new Prisma.Decimal(0));
  }

  for (const ticket of completedTickets) {
    // หารเงินตาม snapshot ของแผง ถ้าไม่มี snapshot ใช้ roster ที่ยัง WORKING แทน (ห้าม throw)
    const snapshotWorkerIds = ticket.workerSnapshots.map(
      (snapshot) => snapshot.ticketWorkerId,
    );
    const boothWorkerIds =
      snapshotWorkerIds.length > 0
        ? snapshotWorkerIds
        : workingWorkers.map((worker) => worker.id);
    const boothWorkers = boothWorkerIds
      .map((id) => ticketWorkerById.get(id))
      .filter((worker): worker is NonNullable<typeof worker> => worker !== undefined);
    const boothWorkerCount = boothWorkers.length;

    if (boothWorkerCount <= 0) {
      throw new ApiError(
        409,
        "TICKET_WORKERS_NOT_FOUND",
        `Booth ${ticket.id} does not have a worker snapshot for financialization.`,
      );
    }

    for (const worker of boothWorkers) {
      distinctPaidWorkerIds.add(worker.id);
    }

    for (const product of ticket.products) {
      if (product.confirmedQuantity === null) {
        throw new ApiError(
          409,
          "CONFIRMED_QUANTITY_MISSING",
          `Confirmed quantity is missing for ticket product ${product.id}.`,
        );
      }

      if (!hasCompleteRateSnapshot(product)) {
        throw new ApiError(
          409,
          "TICKET_RATE_SNAPSHOT_INCOMPLETE",
          `Rate snapshot is incomplete for ticket product ${product.id}.`,
        );
      }

      // TypeScript ยังมอง field เป็น nullable แม้ผ่าน hasCompleteRateSnapshot แล้ว จึงเก็บเป็นตัวแปรหลัง validation
      const stallRate = product.stallRateSnapshot;

      const laborRate = product.laborRateSnapshot;

      if (stallRate === null || laborRate === null) {
        throw new ApiError(
          409,
          "TICKET_RATE_SNAPSHOT_INCOMPLETE",
          `Rate snapshot is incomplete for ticket product ${product.id}.`,
        );
      }

      // คำนวณยอดที่แผงต้องจ่าย ด้วย confirmed quantity เท่านั้น
      const stallCharge = calculateProductStallCharge({
        quantity: product.confirmedQuantity,

        stallRate,

        laborRate,
      });

      // คำนวณเงิน Worker ด้วย Snapshot Worker Count ของแผงนี้โดยเฉพาะ (ไม่ใช่ของทั้ง Ticket)
      const workerPayment = calculateProductWorkerPayment({
        laborFeeRaw: stallCharge.laborFeeRaw,

        actualWorkerCount: boothWorkerCount,
      });

      // เศษจากการปัดขึ้นค่าแรงรวมอยู่ใน productCharge จึงต้องบวกเข้ากองทุนให้ยอดรวมตรงกัน
      const stallLaborRoundingMargin = stallCharge.productCharge
        .minus(stallCharge.stallFeeRounded)
        .minus(stallCharge.laborFeeRaw);
      const fundAmount = workerPayment.fundAmount.plus(stallLaborRoundingMargin);

      const workerPayments = boothWorkers.map((worker) => {
        const finalAmount = workerPayment.finalAmountPerWorker;
        const currentTotal =
          finalEarningByTicketWorkerId.get(worker.id) ?? new Prisma.Decimal(0);

        finalEarningByTicketWorkerId.set(
          worker.id,
          currentTotal.plus(finalAmount),
        );

        return {
          ticketWorkerId: worker.id,

          rawAmount: workerPayment.rawAmountPerWorker,

          remainderAmount: workerPayment.remainderAmountPerWorker,

          finalAmount,
        };
      });

      await ticketFinancialRepository.createTicketProductFinancial(
        {
          ticketProductId: product.id,

          confirmedQuantity: product.confirmedQuantity,

          stallFeeRaw: stallCharge.stallFeeRaw,

          stallFeeRounded: stallCharge.stallFeeRounded,

          laborFeeRaw: stallCharge.laborFeeRaw,

          productCharge: stallCharge.productCharge,

          workerCount: boothWorkerCount,

          workerPayoutTotal: workerPayment.workerPayoutTotal,

          fundAmount,

          finalizedAt,

          shirtColorSnapshot: resolveShirtColorSnapshot(boothWorkers),

          workerPayments,
        },
        connection,
      );

      // รวมเฉพาะ ProductCharge ที่ผ่านการปัดตาม Method A แล้ว
      finalStallAmount = finalStallAmount.plus(stallCharge.productCharge);
      boothStallAmountByTicketId.set(
        ticket.id,
        (boothStallAmountByTicketId.get(ticket.id) ?? new Prisma.Decimal(0)).plus(
          stallCharge.productCharge,
        ),
      );
    }
  }

  await ticketFinancialRepository.updateTicketWorkerFinalEarningAmounts(
    finalEarningByTicketWorkerId,
    connection,
  );

  // บันทึกยอดรวมแยกรายบูธไว้ประกอบการแสดงผล Admin (ไม่ใช่ guard หลัก)
  for (const [ticketId, boothStallAmount] of boothStallAmountByTicketId) {
    await ticketFinancialRepository.markBoothJobFinancializedInfo(
      ticketId,
      boothStallAmount,
      finalizedAt,
      connection,
    );
  }

  await ticketFinancialRepository.markMarketJobFinancialized(
    context.id,
    finalStallAmount,
    finalizedAt,
    connection,
  );

  return {
    marketJobId: context.id,

    productCount: products.length,

    // จำนวน worker ที่ได้เงินจริง (รวมจาก snapshot ทุกแผง)
    workerCount: distinctPaidWorkerIds.size,

    finalStallAmount,

    finalizedAt,

    alreadyFinalized: false,
  };
}
