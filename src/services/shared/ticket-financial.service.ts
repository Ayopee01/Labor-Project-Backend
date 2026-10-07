// Import Library
import { Prisma } from "@prisma/client";
// Import Config
import { SHIRT_COLOR_SNAPSHOT, TICKET_STATUS, TICKET_WORKER_STATUS, TERMINAL_TICKET_STATUSES } from "../../constants/status";
// Import Repositories
import * as ticketFinancialRepository from "../../repositories/shared/ticket-financial.repository";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";
import type { BoothPayoutRecalculation, TicketFinancializationResult } from "../../types/shared/ticket-financial.type";
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

// Function คิดยอดแผงรายสินค้า (ปัดเศษแล้ว) และยอดรวมของแผงตอน Vendor ยืนยัน แล้วบันทึกไว้ใช้ตอนปิดยอด
export async function recordBoothStallCharges(
  ticketId: number,
  connection?: DbConnection,
): Promise<Prisma.Decimal> {
  const products = await ticketFinancialRepository.listBoothStallChargeProducts(
    ticketId,
    connection,
  );
  let finalStallAmount = new Prisma.Decimal(0);

  for (const product of products) {
    if (product.confirmedQuantity === null) {
      throw new ApiError(
        409,
        "CONFIRMED_QUANTITY_MISSING",
        `Confirmed quantity is missing for ticket product ${product.id}.`,
      );
    }

    if (
      !hasCompleteRateSnapshot(product) ||
      product.stallRateSnapshot === null ||
      product.laborRateSnapshot === null
    ) {
      throw new ApiError(
        409,
        "TICKET_RATE_SNAPSHOT_INCOMPLETE",
        `Rate snapshot is incomplete for ticket product ${product.id}.`,
      );
    }

    // คิดยอดที่แผงต้องจ่าย ด้วย confirmed quantity เท่านั้น
    const stallCharge = calculateProductStallCharge({
      quantity: product.confirmedQuantity,

      stallRate: product.stallRateSnapshot,

      laborRate: product.laborRateSnapshot,
    });

    await ticketFinancialRepository.updateTicketProductStallCharge(
      product.id,
      {
        stallFeeRaw: stallCharge.stallFeeRaw,

        stallFeeRounded: stallCharge.stallFeeRounded,

        laborFeeRaw: stallCharge.laborFeeRaw,

        productCharge: stallCharge.productCharge,
      },
      connection,
    );

    finalStallAmount = finalStallAmount.plus(stallCharge.productCharge);
  }

  await ticketFinancialRepository.updateBoothJobFinalStallAmount(
    ticketId,
    finalStallAmount,
    connection,
  );

  return finalStallAmount;
}

// Type ข้อมูล Business Ticket, แผง และ roster ที่ใช้ปิดยอดเงิน
type FinancializationContext = NonNullable<
  Awaited<ReturnType<typeof ticketFinancialRepository.findMarketJobFinancializationContext>>
>;
// Type แผงใน context ปิดยอดเงิน
type FinancializationBooth = FinancializationContext["tickets"][number];
// Type สินค้าของแผงใน context ปิดยอดเงิน
type FinancializationProduct = FinancializationBooth["products"][number];
// Type roster ของ Business Ticket ใน context ปิดยอดเงิน
type FinancializationTicketWorker = FinancializationContext["ticketWorkers"][number];

// Function ดึงยอดแผงรายสินค้าที่บันทึกตอน Vendor ยืนยัน (ไม่มีครบ throw 409)
function requireProductStallCharge(product: FinancializationProduct) {
  const { confirmedQuantity, stallFeeRounded, laborFeeRaw, productCharge } = product;

  if (
    confirmedQuantity === null ||
    product.stallFeeRaw === null ||
    stallFeeRounded === null ||
    laborFeeRaw === null ||
    productCharge === null
  ) {
    throw new ApiError(
      409,
      "TICKET_STALL_CHARGE_MISSING",
      `Stall charge is missing for ticket product ${product.id}.`,
    );
  }

  return { confirmedQuantity, stallFeeRounded, laborFeeRaw, productCharge };
}

// Function หา worker ที่ได้เงินของแผง = snapshot ตอนยืนยัน ลบคนที่ Admin ถอดออกจากแผง
function resolveBoothPayoutWorkers(
  booth: FinancializationBooth,
  ticketWorkers: FinancializationTicketWorker[],
): FinancializationTicketWorker[] {
  const excludedIds = new Set(booth.workerExclusions.map((exclusion) => exclusion.ticketWorkerId));
  const ticketWorkerById = new Map(ticketWorkers.map((worker) => [worker.id, worker]));

  return booth.workerSnapshots
    .map((snapshot) => snapshot.ticketWorkerId)
    .filter((id) => !excludedIds.has(id))
    .map((id) => ticketWorkerById.get(id))
    .filter((worker): worker is FinancializationTicketWorker => worker !== undefined);
}

// Function คำนวณเงิน Worker และกองทุนของสินค้าหนึ่งรายการตามกลุ่มที่ได้เงินของแผง
function buildProductWorkerFinancial(
  product: FinancializationProduct,
  boothWorkers: FinancializationTicketWorker[],
) {
  const { confirmedQuantity, stallFeeRounded, laborFeeRaw, productCharge } =
    requireProductStallCharge(product);
  const workerPayment = calculateProductWorkerPayment({
    laborFeeRaw,
    actualWorkerCount: boothWorkers.length,
  });
  // เศษจากการปัดขึ้นค่าแรงรวมอยู่ใน productCharge จึงต้องบวกเข้ากองทุนให้ยอดรวมตรงกัน
  const stallLaborRoundingMargin = productCharge.minus(stallFeeRounded).minus(laborFeeRaw);

  return {
    confirmedQuantity,
    workerCount: boothWorkers.length,
    workerPayoutTotal: workerPayment.workerPayoutTotal,
    fundAmount: workerPayment.fundAmount.plus(stallLaborRoundingMargin),
    shirtColorSnapshot: resolveShirtColorSnapshot(boothWorkers),
    workerPayments: boothWorkers.map((worker) => ({
      ticketWorkerId: worker.id,
      rawAmount: workerPayment.rawAmountPerWorker,
      remainderAmount: workerPayment.remainderAmountPerWorker,
      finalAmount: workerPayment.finalAmountPerWorker,
    })),
  };
}

// Function รวมเงินรายคนของแผงจาก workerPayments ของทุกสินค้า (ใช้เก็บยอดก่อน/หลังลง audit)
function sumBoothWorkerAmounts(
  products: Array<{ workerPayments: Array<{ ticketWorkerId: number; finalAmount: Prisma.Decimal }> }>,
): Map<number, Prisma.Decimal> {
  const totals = new Map<number, Prisma.Decimal>();

  for (const product of products) {
    for (const payment of product.workerPayments) {
      totals.set(
        payment.ticketWorkerId,
        (totals.get(payment.ticketWorkerId) ?? new Prisma.Decimal(0)).plus(payment.finalAmount),
      );
    }
  }

  return totals;
}

// Function แปลงยอดรายคนเป็น object ที่บันทึกลง JSON ได้ (key = ticket_worker_id)
function formatWorkerAmounts(totals: Map<number, Prisma.Decimal>): Record<string, string> {
  return Object.fromEntries(
    [...totals].map(([ticketWorkerId, amount]) => [String(ticketWorkerId), amount.toFixed(2)]),
  );
}

// Function ปิดยอดเงินของ Business Ticket ทั้งใบ (ทุกแผงต้องจบ และหารเงินตามกลุ่มที่ได้เงินของแต่ละแผง)
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
  if (products.some((product) => product.financial !== null)) {
    throw new ApiError(
      500,
      "TICKET_FINANCIAL_PARTIAL_STATE",
      "Business ticket has partial financial records before finalization.",
    );
  }

  // roster ที่ยัง WORKING ได้ final_earning_amount เริ่มที่ 0 แม้ไม่ได้เงินแผงใด
  const workingWorkerIds = context.ticketWorkers
    .filter((worker) => worker.status === TICKET_WORKER_STATUS.WORKING)
    .map((worker) => worker.id);
  // ตรวจทุกแผงก่อนเขียนอะไร: ต้องมียอดแผงจากตอน Vendor ยืนยัน และเหลือคนได้เงินอย่างน้อย 1 คน
  const boothWorkersByTicketId = new Map<number, FinancializationTicketWorker[]>();

  for (const ticket of completedTickets) {
    const boothWorkers = resolveBoothPayoutWorkers(ticket, context.ticketWorkers);

    if (boothWorkers.length <= 0) {
      throw new ApiError(
        409,
        "TICKET_WORKERS_NOT_FOUND",
        `Booth ${ticket.id} does not have a worker snapshot for financialization.`,
      );
    }

    boothWorkersByTicketId.set(ticket.id, boothWorkers);
  }

  for (const ticket of completedTickets) {
    if (ticket.finalStallAmount === null) {
      throw new ApiError(
        409,
        "TICKET_STALL_CHARGE_MISSING",
        `Booth ${ticket.id} does not have a final stall amount.`,
      );
    }

    ticket.products.forEach(requireProductStallCharge);
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
  const distinctPaidWorkerIds = new Set<number>();

  for (const workerId of workingWorkerIds) {
    finalEarningByTicketWorkerId.set(workerId, new Prisma.Decimal(0));
  }

  for (const ticket of completedTickets) {
    const boothWorkers = boothWorkersByTicketId.get(ticket.id) ?? [];

    for (const worker of boothWorkers) {
      distinctPaidWorkerIds.add(worker.id);
    }

    for (const product of ticket.products) {
      const financial = buildProductWorkerFinancial(product, boothWorkers);

      for (const payment of financial.workerPayments) {
        finalEarningByTicketWorkerId.set(
          payment.ticketWorkerId,
          (finalEarningByTicketWorkerId.get(payment.ticketWorkerId) ?? new Prisma.Decimal(0)).plus(
            payment.finalAmount,
          ),
        );
      }

      await ticketFinancialRepository.createTicketProductFinancial(
        { ticketProductId: product.id, finalizedAt, ...financial },
        connection,
      );
    }

    // ยอดทั้งใบ = ผลรวมยอดแผงที่บันทึกไว้ตอน Vendor ยืนยัน
    finalStallAmount = finalStallAmount.plus(ticket.finalStallAmount ?? 0);

    await ticketFinancialRepository.markBoothJobFinancialized(
      ticket.id,
      finalizedAt,
      connection,
    );
  }

  await ticketFinancialRepository.updateTicketWorkerFinalEarningAmounts(
    finalEarningByTicketWorkerId,
    connection,
  );

  await ticketFinancialRepository.markMarketJobFinancialized(
    context.id,
    finalStallAmount,
    finalizedAt,
    connection,
  );

  return {
    marketJobId: context.id,
    productCount: products.length,
    // จำนวน worker ที่ได้เงินจริง (รวมจากทุกแผง)
    workerCount: distinctPaidWorkerIds.size,
    finalStallAmount,
    finalizedAt,
    alreadyFinalized: false,
  };
}

// Function คิดเงิน Worker ของแผงที่ปิดยอดแล้วใหม่หลัง Admin เปลี่ยนคนได้เงิน (ตลาดยังไม่ปิดยอดคืน null)
export async function refinalizeBoothWorkerPayments(
  marketJobId: number,
  boothJobId: number,
  connection: DbConnection,
): Promise<BoothPayoutRecalculation | null> {
  // lock Business Ticket กันคิดเงินแผงในใบเดียวกันพร้อมกันแล้วยอดรายคนรวมผิด
  await connection.$queryRaw`SELECT id FROM market_jobs WHERE id = ${marketJobId} FOR UPDATE`;

  const context =
    await ticketFinancialRepository.findMarketJobFinancializationContext(marketJobId, connection);
  const booth = context?.tickets.find((ticket) => ticket.id === boothJobId);

  if (!context || !booth) {
    throw new ApiError(404, "STALL_JOB_NOT_FOUND", "Stall job not found.");
  }

  if (!context.financializedAt || booth.status !== TICKET_STATUS.COMPLETED) {
    return null;
  }

  const financials = booth.products.map((product) => {
    if (!product.financial) {
      throw new ApiError(
        500,
        "TICKET_FINANCIAL_STATE_INVALID",
        `Financialized booth ${booth.id} has product ${product.id} without financial record.`,
      );
    }

    return { product, financial: product.financial };
  });
  const boothWorkers = resolveBoothPayoutWorkers(booth, context.ticketWorkers);

  if (boothWorkers.length <= 0) {
    throw new ApiError(
      409,
      "BOOTH_MIN_ONE_WORKER",
      "A confirmed booth must keep at least one paid worker.",
      { boothJobId },
    );
  }

  const amountsBefore = sumBoothWorkerAmounts(financials.map(({ financial }) => financial));
  const productChanges: BoothPayoutRecalculation["products"] = [];
  const recalculated: Array<ReturnType<typeof buildProductWorkerFinancial>> = [];

  for (const { product, financial } of financials) {
    const next = buildProductWorkerFinancial(product, boothWorkers);

    await ticketFinancialRepository.replaceTicketProductWorkerFinancial(
      financial.id,
      {
        workerCount: next.workerCount,
        workerPayoutTotal: next.workerPayoutTotal,
        fundAmount: next.fundAmount,
        shirtColorSnapshot: next.shirtColorSnapshot,
        workerPayments: next.workerPayments,
      },
      connection,
    );

    recalculated.push(next);
    productChanges.push({
      ticketProductId: product.id,
      workerCountBefore: financial.workerCount,
      workerCountAfter: next.workerCount,
      workerPayoutTotalBefore: financial.workerPayoutTotal.toFixed(2),
      workerPayoutTotalAfter: next.workerPayoutTotal.toFixed(2),
      fundAmountBefore: financial.fundAmount.toString(),
      fundAmountAfter: next.fundAmount.toString(),
    });
  }

  await ticketFinancialRepository.recalculateMarketJobWorkerEarnings(marketJobId, connection);

  return {
    marketJobId,
    boothJobId,
    ticketWorkerIdsBefore: [...amountsBefore.keys()],
    ticketWorkerIdsAfter: boothWorkers.map((worker) => worker.id),
    products: productChanges,
    workerAmountsBefore: formatWorkerAmounts(amountsBefore),
    workerAmountsAfter: formatWorkerAmounts(sumBoothWorkerAmounts(recalculated)),
  };
}
