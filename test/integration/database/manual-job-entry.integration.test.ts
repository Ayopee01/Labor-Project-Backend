// Import Library
import assert from "node:assert/strict";
import { test } from "node:test";
import { Prisma } from "@prisma/client";
// Import Config
import { ASSIGNMENT_STATUS, DAILY_WORKER_INCOME_PAYMENT_STATUS, TICKET_JOB_ENTRY_MODE, VEHICLE_JOB_STATUS } from "../../../src/constants/status";
// Import Repositories
import * as adminJobsRepository from "../../../src/repositories/admin-jobs.repository";
import * as adminManualJobsRepository from "../../../src/repositories/admin-manual-jobs.repository";
import * as workerRepository from "../../../src/repositories/worker.repository";
// Import Services
import * as adminManualJobsService from "../../../src/services/admin-manual-jobs.service";
// Import Types
import type { AdminManualJobInput } from "../../../src/types/admin-jobs.type";
import type { DbConnection } from "../../../src/types/shared/common.type";
// Import Utils
import { calculateProductStallCharge, calculateProductWorkerPayment } from "../../../src/utils/labor-job-pricing";
// Import Helpers
import { assertSafeTestDatabaseUrl } from "../../setup/test-env";

/* -------------------------------------- Config -------------------------------------- */

const runDbTests = process.env.RUN_DB_TESTS === "1";

// Config วันที่ทำงานของข้อมูลทดสอบ (วันในอดีตที่ไม่มีข้อมูลอื่น)
const WORK_STARTED_AT = "2021-03-15T08:00:00.000+07:00";
const COMPLETED_AT = "2021-03-15T09:30:00.000+07:00";
const DAY_START = new Date("2021-03-15T00:00:00.000+07:00");
const DAY_END = new Date("2021-03-16T00:00:00.000+07:00");

// Config rate ของตลาดทดสอบ (ตัวอย่างเดียวกับ docs/flow.md)
const STALL_RATE = new Prisma.Decimal("1.50");
const LABOR_RATE = new Prisma.Decimal("0.90");

/* -------------------------------------- Helpers -------------------------------------- */

// Class error ใช้บังคับ rollback transaction หลังจบ test
class RollbackTestTransaction extends Error {}

// Function รัน callback ใน transaction แล้ว rollback เสมอ
async function runRollbackTest(
  callback: (tx: DbConnection) => Promise<void>
): Promise<void> {
  const { prisma, closePrisma } = await import("../../../src/db/prisma");

  try {
    await prisma.$transaction(
      async (tx) => {
        await callback(tx);
        throw new RollbackTestTransaction();
      },
      { timeout: 60_000 },
    );
  } catch (error) {
    if (!(error instanceof RollbackTestTransaction)) {
      throw error;
    }
  } finally {
    await closePrisma();
  }
}

// Function สร้าง master data (ตลาด แผง สินค้า rate) worker 3 คน และ Admin สำหรับงานบันทึกย้อนหลัง
async function seedManualJobMasterData(tx: DbConnection) {
  const suffix = `${Date.now().toString(36).slice(-5)}${Math.floor(Math.random() * 1000)}`;
  const marketCode = `MJ${suffix}`;
  const sourceId = 900_000_000 + Math.floor(Math.random() * 90_000_000);

  for (const [index, boothCode] of ["B1", "B2"].entries()) {
    await tx.masterMarket.create({
      data: {
        sourceBoothId: sourceId + index,
        marketCode,
        marketName: `Market ${suffix}`,
        boothCode,
        boothName: `Booth ${boothCode}`,
        marketStatus: "Normal",
        boothStatus: "Normal",
      },
    });
  }

  await tx.masterProduct.create({
    data: {
      id: sourceId,
      productCode: `P${suffix}`,
      productFullCode: `P${suffix}-FULL`,
      productName: "Manual Product",
      packageCode: `K${suffix}`,
      packageName: "Manual Package",
      packageWeight: 20,
      range: {
        workerRanges: {
          range1To50: 2,
          range51To100: 3,
          range101To200: 4,
          range201To400: 5,
          range401To600: 6,
          rangeOver600: 7,
        },
      },
      status: "ACTIVE",
      updateDate: new Date(),
    },
  });
  await tx.masterRate.create({
    data: {
      sourceRateId: sourceId,
      marketCode,
      weightRangeName: "10-30",
      weightMin: new Prisma.Decimal("10"),
      weightMax: new Prisma.Decimal("30"),
      stallRate: STALL_RATE,
      laborRate: LABOR_RATE,
      status: 1,
    },
  });

  const workers = [];

  for (const index of ["1", "2", "3"]) {
    workers.push(
      await tx.masterWorker.create({
        data: {
          laborCode: `MJW${index}-${suffix}`,
          fullName: `Manual Worker ${index}`,
          status: 1,
        },
      })
    );
  }

  const admin = await tx.account.create({
    data: {
      username: `mj-admin-${suffix}`,
      passwordHash: "x",
      role: "admin",
      fullName: `Admin ${suffix}`,
    },
  });

  return {
    suffix,
    marketCode,
    productCode: `P${suffix}`,
    packageCode: `K${suffix}`,
    workers,
    adminId: admin.id,
  };
}

// Function สร้าง body งานบันทึกย้อนหลัง 1 ตลาด 2 แผง (แผง B1 ทำ 2 คน, แผง B2 ทำ 1 คน)
function buildManualJobInput(
  seed: Awaited<ReturnType<typeof seedManualJobMasterData>>,
  overrides: Partial<AdminManualJobInput> = {},
  quantities: [number, number] = [4, 7]
): AdminManualJobInput {
  const [worker1, worker2, worker3] = seed.workers;

  return {
    ticket_number: `MJ-TN-${seed.suffix}`,
    license_plate: `MJ-${seed.suffix}`,
    license_plate_province: "Bangkok",
    work_started_at: WORK_STARTED_AT,
    completed_at: COMPLETED_AT,
    markets: [
      {
        ticket_no: `MJ-NO-${seed.suffix}`,
        marketCode: seed.marketCode,
        dropoff_point: "Gate A",
        booths: [
          {
            boothCode: "B1",
            worker_codes: [worker1.laborCode, worker2.laborCode],
            products: [{ productCode: seed.productCode, packageCode: seed.packageCode, quantity: quantities[0] }],
          },
          {
            boothCode: "B2",
            worker_codes: [worker3.laborCode],
            products: [{ productCode: seed.productCode, packageCode: seed.packageCode, quantity: quantities[1] }],
          },
        ],
      },
    ],
    ...overrides,
  };
}

// Function คำนวณยอดที่ควรได้ของสินค้า 1 รายการด้วยสูตรเดียวกับ flow ปกติ
function expectProductAmounts(quantity: number, workerCount: number) {
  const stallCharge = calculateProductStallCharge({
    quantity: new Prisma.Decimal(quantity),
    stallRate: STALL_RATE,
    laborRate: LABOR_RATE,
  });
  const workerPayment = calculateProductWorkerPayment({
    laborFeeRaw: stallCharge.laborFeeRaw,
    actualWorkerCount: workerCount,
  });

  return { stallCharge, workerPayment };
}

/* -------------------------------------- Tests -------------------------------------- */

test("manual job entry saves a completed job with the same money as the normal flow on the real work date", { skip: !runDbTests }, async () => {
  assertSafeTestDatabaseUrl();

  await runRollbackTest(async (tx) => {
    const seed = await seedManualJobMasterData(tx);
    const input = buildManualJobInput(seed);
    const { ticketJobId, warnings } = await adminManualJobsService.saveManualJob(input, seed.adminId, null, tx);
    const record = await adminManualJobsRepository.findManualJobRecordById(ticketJobId, tx);
    const booth1 = expectProductAmounts(4, 2);
    const booth2 = expectProductAmounts(7, 1);

    assert.ok(record);
    assert.deepEqual(warnings, []);
    assert.equal(record.entryMode, TICKET_JOB_ENTRY_MODE.MANUAL);
    assert.equal(record.status, VEHICLE_JOB_STATUS.COMPLETED);
    assert.equal(record.createdAt.toISOString(), new Date(WORK_STARTED_AT).toISOString());
    assert.equal(record.completedAt?.toISOString(), new Date(COMPLETED_AT).toISOString());

    const [market] = record.marketJobs;

    assert.equal(market.status, VEHICLE_JOB_STATUS.COMPLETED);
    assert.equal(market.financializedAt?.toISOString(), new Date(COMPLETED_AT).toISOString());
    assert.equal(
      market.finalStallAmount?.toFixed(2),
      booth1.stallCharge.productCharge.plus(booth2.stallCharge.productCharge).toFixed(2)
    );

    const [b1, b2] = market.tickets;

    assert.equal(b1.products[0].productCharge?.toFixed(2), booth1.stallCharge.productCharge.toFixed(2));
    assert.equal(b1.products[0].confirmedQuantity?.toFixed(2), "4.00");
    assert.equal(b1.products[0].financial?.workerPayoutTotal.toFixed(2), booth1.workerPayment.workerPayoutTotal.toFixed(2));
    assert.equal(b1.products[0].financial?.workerPayments.length, 2);
    assert.equal(
      b1.products[0].financial?.finalizedAt.toISOString(),
      new Date(COMPLETED_AT).toISOString()
    );
    assert.equal(b2.products[0].financial?.workerPayments.length, 1);
    assert.equal(
      b2.products[0].financial?.workerPayments[0].finalAmount.toFixed(2),
      booth2.workerPayment.finalAmountPerWorker.toFixed(2)
    );

    // ประวัติงานของ worker เห็นงานนี้ในวันที่ทำงานจริง
    const history = await workerRepository.listWorkerAssignmentHistoryByDate(seed.workers[0].id, DAY_START, DAY_END, tx);

    assert.equal(history.length, 1);
    assert.equal(history[0].entry_mode, TICKET_JOB_ENTRY_MODE.MANUAL);
    assert.equal(history[0].assignment.status, ASSIGNMENT_STATUS.COMPLETED);

    // รายงานรายได้รายวันนับเป็นจ่ายสำเร็จทั้ง 3 คน
    const income = await adminJobsRepository.listDailyWorkerIncome(
      { startAt: DAY_START, endAt: DAY_END, search: seed.suffix, sortOrder: "newest", page: 1, limit: 50 },
      tx
    );

    assert.equal(income.summary.row_count, 3);
    assert.ok(income.rows.every((row) => row.payment_status === DAILY_WORKER_INCOME_PAYMENT_STATUS.SUCCESS));
    assert.equal(
      income.summary.payable_total.toFixed(2),
      booth1.workerPayment.workerPayoutTotal.plus(booth2.workerPayment.workerPayoutTotal).toFixed(2)
    );
  });
});

test("manual job entry warns when a worker already worked another job in the same time range", { skip: !runDbTests }, async () => {
  assertSafeTestDatabaseUrl();

  await runRollbackTest(async (tx) => {
    const seed = await seedManualJobMasterData(tx);

    await adminManualJobsService.saveManualJob(buildManualJobInput(seed), seed.adminId, null, tx);

    // งานที่สองใช้ worker คนเดิมในช่วงเวลาทับกัน: บันทึกได้แต่มีคำเตือน
    const second = buildManualJobInput(seed, {
      ticket_number: `MJ-TN2-${seed.suffix}`,
      work_started_at: "2021-03-15T09:00:00.000+07:00",
      completed_at: "2021-03-15T10:00:00.000+07:00",
    });

    second.markets[0].ticket_no = `MJ-NO2-${seed.suffix}`;

    const { warnings } = await adminManualJobsService.saveManualJob(second, seed.adminId, null, tx);

    assert.equal(warnings.length, 3);
    assert.ok(warnings.every((warning) => warning.code === "WORKER_TIME_OVERLAP"));
    assert.ok(warnings.every((warning) => warning.ticket_number === `MJ-TN-${seed.suffix}`));
  });
});

test("manual job entry rejects a TicketNumber or TicketNo that was already issued", { skip: !runDbTests }, async () => {
  assertSafeTestDatabaseUrl();

  await runRollbackTest(async (tx) => {
    const seed = await seedManualJobMasterData(tx);
    const input = buildManualJobInput(seed);

    await adminManualJobsService.saveManualJob(input, seed.adminId, null, tx);

    await assert.rejects(
      adminManualJobsService.saveManualJob(input, seed.adminId, null, tx),
      (error: { code?: string }) => error.code === "TICKET_NUMBER_ALREADY_EXISTS"
    );
    await assert.rejects(
      adminManualJobsService.saveManualJob(
        buildManualJobInput(seed, { ticket_number: `MJ-TN3-${seed.suffix}` }),
        seed.adminId,
        null,
        tx
      ),
      (error: { code?: string }) => error.code === "TICKET_NO_ALREADY_EXISTS"
    );
  });
});

test("manual job entry update replaces the job in place and delete removes it but keeps the admin log", { skip: !runDbTests }, async () => {
  assertSafeTestDatabaseUrl();

  await runRollbackTest(async (tx) => {
    const seed = await seedManualJobMasterData(tx);
    const { ticketJobId } = await adminManualJobsService.saveManualJob(buildManualJobInput(seed), seed.adminId, null, tx);

    await tx.adminActionLog.create({
      data: {
        ticketJobId,
        actionType: "MANUAL_JOB_CREATED",
        reasonCode: "SYSTEM_DOWN",
        actorAccountId: seed.adminId,
      },
    });

    // แก้จำนวนแผง B1 จาก 4 เป็น 60 ใช้เลขตั๋วเดิมได้ และคิดเงินใหม่ทั้งงาน
    const { ticketJobId: updatedId } = await adminManualJobsService.saveManualJob(
      buildManualJobInput(seed, {}, [60, 7]),
      seed.adminId,
      ticketJobId,
      tx
    );
    const updated = await adminManualJobsRepository.findManualJobRecordById(ticketJobId, tx);
    const booth1 = expectProductAmounts(60, 2);

    assert.equal(updatedId, ticketJobId);
    assert.ok(updated);
    assert.equal(updated.marketJobs.length, 1);
    assert.equal(updated.marketJobs[0].tickets[0].products[0].productCharge?.toFixed(2), booth1.stallCharge.productCharge.toFixed(2));
    assert.equal(await tx.ticketJobAssignment.count({ where: { ticketJobId } }), 3);
    assert.equal(await tx.ticketWorker.count({ where: { marketJob: { ticketJobId } } }), 3);

    await adminManualJobsRepository.deleteTicketJobChildren(ticketJobId, tx);
    await adminManualJobsRepository.deleteTicketJob(ticketJobId, tx);

    assert.equal(await tx.ticketJob.count({ where: { id: ticketJobId } }), 0);
    assert.equal(await tx.ticketJobAssignment.count({ where: { ticketJobId } }), 0);
    assert.equal(await tx.ticketWorker.count({ where: { workerId: { in: seed.workers.map((worker) => worker.id) } } }), 0);
    assert.equal(await tx.adminActionLog.count({ where: { actorAccountId: seed.adminId, ticketJobId: null } }), 1);
  });
});

test("manual job list filters by work date and search, pages results and sums the saved amounts", { skip: !runDbTests }, async () => {
  assertSafeTestDatabaseUrl();

  await runRollbackTest(async (tx) => {
    const seed = await seedManualJobMasterData(tx);
    const first = buildManualJobInput(seed);
    const second = buildManualJobInput(seed, {
      ticket_number: `MJ-TN2-${seed.suffix}`,
      work_started_at: "2021-03-15T11:00:00.000+07:00",
      completed_at: "2021-03-15T12:00:00.000+07:00",
    });

    second.markets[0].ticket_no = `MJ-NO2-${seed.suffix}`;

    await adminManualJobsService.saveManualJob(first, seed.adminId, null, tx);
    await adminManualJobsService.saveManualJob(second, seed.adminId, null, tx);

    const filters = { startAt: DAY_START, endAt: DAY_END, search: seed.suffix, page: 1, limit: 1 };
    const pageOne = await adminManualJobsRepository.listManualJobs(filters, tx);
    const pageTwo = await adminManualJobsRepository.listManualJobs({ ...filters, page: 2 }, tx);
    const booth1 = expectProductAmounts(4, 2);
    const booth2 = expectProductAmounts(7, 1);

    // งานล่าสุด (เริ่ม 11:00) มาก่อน
    assert.equal(pageOne.total, 2);
    assert.equal(pageOne.records[0].ticketNumber, `MJ-TN2-${seed.suffix}`);
    assert.equal(pageTwo.records[0].ticketNumber, `MJ-TN-${seed.suffix}`);
    assert.equal(pageOne.records[0]._count.assignments, 3);
    assert.equal(pageOne.records[0].marketJobs[0]._count.tickets, 2);
    assert.equal(
      pageOne.records[0].marketJobs[0].finalStallAmount?.toFixed(2),
      booth1.stallCharge.productCharge.plus(booth2.stallCharge.productCharge).toFixed(2)
    );
    // ค่าแผงของรายการ = ผลรวม stall_fee_rounded ของทุกสินค้า (ไม่รวมค่าแรง)
    assert.equal(
      pageOne.records[0].marketJobs[0].tickets
        .flatMap((booth) => booth.products)
        .reduce((sum, product) => sum.plus(product.stallFeeRounded ?? 0), new Prisma.Decimal(0))
        .toFixed(2),
      booth1.stallCharge.stallFeeRounded.plus(booth2.stallCharge.stallFeeRounded).toFixed(2)
    );

    // ค้นจาก TicketNo และวันอื่นไม่เจอ
    const byTicketNo = await adminManualJobsRepository.listManualJobs(
      { ...filters, search: `mj-no2-${seed.suffix}`, limit: 20 },
      tx
    );
    const otherDay = await adminManualJobsRepository.listManualJobs(
      { ...filters, startAt: DAY_END, endAt: new Date(DAY_END.getTime() + 86_400_000), limit: 20 },
      tx
    );

    assert.equal(byTicketNo.total, 1);
    assert.equal(otherDay.total, 0);
  });
});
