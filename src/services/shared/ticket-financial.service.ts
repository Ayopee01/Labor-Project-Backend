// Import Library
import { Prisma } from "@prisma/client";

// Import Repositories
import * as ticketFinancialRepository from "../../repositories/shared/ticket-financial.repository";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";
import type { TicketFinancializationResult } from "../../types/shared/ticket-financial.type";
// Import Config
import { SHIRT_COLOR_SNAPSHOT, TICKET_STATUS, TICKET_WORKER_STATUS, TERMINAL_TICKET_STATUSES } from "../../constants/status";
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

// Function คำนวณ shirt_color_snapshot ของ worker ที่หารเงินแผง/สินค้าหนึ่งรายการ ใช้ MasterWorker.laborColor ตรงตัว (case-sensitive)
// สีเดียวกันทุกคน -> ใช้สีนั้นตรงจาก master data เลย (ไม่ผูกกับ whitelist คงที่ในโค้ด รองรับสีใหม่ที่ master data
// เพิ่มมาในอนาคตได้ทันที), สีต่างกัน -> MIXED, ไม่มีค่า -> UNKNOWN
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

// Function Finalize เงินทั้งหมดของ Business Ticket (market job) ทั้งใบ
// เงื่อนไข: ทุก Booth ต้อง Terminal และมีอย่างน้อยหนึ่ง Booth COMPLETED, Lock Roster ก่อนคำนวณเสมอ (กัน sync/cancel ซ้ำ)
// คิดแยกแต่ละ Product ด้วย confirmedQuantity + Rate Snapshot เท่านั้น (ห้าม query rate ใหม่)
// Worker หารด้วย Snapshot ของแผงนั้นๆ ตอน confirm ไม่ใช่ roster สุดท้าย เพื่อให้แต่ละแผงหารคนละจำนวนได้ถูกต้อง
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
    // จำนวน worker ที่ได้เงินจริง = union ของ ticketWorkerId จาก workerPayments ทุกแผง (เหมือนตอนคำนวณสด)
    // ห้ามนับจาก finalEarningAmount !== null เพราะถูกเซ็ตเป็น 0 ให้ทุกคนใน Roster ตอน Lock อยู่แล้ว จะนับเกินจริงได้
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

  // ถ้ายังไม่ Financialize แต่มี Product Financial อยู่แล้ว ถือเป็น Partial State ที่ไม่ควรเกิด ห้ามเขียนทับข้อมูลเก่า
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

  // Final Eligible Worker = Roster ที่ยัง WORKING ตอน Lock เท่านั้น ไม่ใช้ TicketJob.workersRequired หรือ Master Worker Range
  const workingWorkers = context.ticketWorkers.filter(
    (worker) => worker.status === TICKET_WORKER_STATUS.WORKING,
  );
  const actualWorkerCount = workingWorkers.length;

  if (actualWorkerCount <= 0) {
    throw new ApiError(
      409,
      "TICKET_WORKERS_NOT_FOUND",
      "Business ticket does not have active workers for financialization.",
    );
  }

  const finalizedAt = new Date();

  // Lock Roster ก่อนคำนวณเสมอ: ตัดสินว่าห้าม Sync/Cancel/Add Worker เข้า Roster นี้อีก (operational guard)
  // ตัวหารเงินจริงต่อแผงมาจาก Snapshot ตอนแผงนั้น confirm ด้านล่าง ไม่ใช่ค่า Lock ตรงนี้
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
    // Worker ที่หารเงินของแผงนี้ = Snapshot ที่บันทึกไว้ตอน confirm (ยัง WORKING ตอนนั้นจริง)
    // ถ้า Snapshot ว่าง fallback ไปใช้ roster สุดท้ายของทั้ง Ticket แทน — เกิดได้ใน flow ปัจจุบันเมื่อ Worker ที่
    // เหลือของแผงถูกถอดทีละชั้น (ถอดคนหนึ่งออกจากแผงนี้ แล้วถอดอีกคนออกจาก roster ทั้ง Ticket) จนไม่เหลือใคร
    // มีสิทธิ์ในแผงตอน confirm ห้าม throw ตรงนี้ เพราะจะทำให้ Vendor confirm แผงนั้น rollback ทุกครั้งจนค้างถาวร
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

      // Method A ปัดขึ้น 2 รอบ: stallFeeRaw -> stallFeeRounded แล้ว +laborFeeRaw -> productCharge (ปัดเศษ laborFeeRaw อีกครั้ง)
      // margin = ceil(laborFeeRaw) - laborFeeRaw คือเงินจริงที่รวมอยู่ใน productCharge แต่ workerPayment หารจาก laborFeeRaw ตรงๆ
      // ต้องบวก margin นี้เข้า fundAmount ไม่งั้น stallFeeRounded+workerPayoutTotal+fundAmount จะไม่เท่ากับ productCharge จริง
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

    // จำนวน worker ที่ได้รับเงินจริง (union ของ snapshot ทุกแผง) ไม่ใช่ roster สุดท้ายทั้ง Ticket เพราะแต่ละแผงอาจมีคนละชุด
    workerCount: distinctPaidWorkerIds.size,

    finalStallAmount,

    finalizedAt,

    alreadyFinalized: false,
  };
}
