// Import Library
import assert from "node:assert/strict";
import { test } from "node:test";
// Import Config
import { TICKET_STATUS, TICKET_WORKER_STATUS, VEHICLE_JOB_STATUS } from "../../../src/constants/status";
// Import Repositories
import * as adminJobsRepository from "../../../src/repositories/admin-jobs.repository";
// Import Types
import { ADMIN_ACTION_TYPE } from "../../../src/types/shared/admin-action-log.type";
import type { DailyWorkerIncomeFilters } from "../../../src/types/admin-jobs.type";
import type { DbConnection } from "../../../src/types/shared/common.type";
// Import Helpers
import { assertSafeTestDatabaseUrl } from "../../setup/test-env";

/* -------------------------------------- Config -------------------------------------- */

const runDbTests = process.env.RUN_DB_TESTS === "1";

// Config วันที่ของข้อมูลทดสอบ (แยกจากข้อมูลอื่นใน DB ด้วยวันในอนาคต)
const BUSINESS_DATE = "2030-03-15";
const DAY_START = new Date(`${BUSINESS_DATE}T00:00:00.000+07:00`);
const DAY_END = new Date(`2030-03-16T00:00:00.000+07:00`);

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

// Function สร้างเวลาในวันทดสอบตามเวลาไทย
function at(time: string): Date {
  return new Date(`${BUSINESS_DATE}T${time}:00.000+07:00`);
}

// Function สร้าง filter ของรายงานพร้อมค่า default ของวันทดสอบ
function buildFilters(overrides: Partial<DailyWorkerIncomeFilters> = {}): DailyWorkerIncomeFilters {
  return {
    startAt: DAY_START,
    endAt: DAY_END,
    sortOrder: "newest",
    page: 1,
    limit: 100,
    ...overrides,
  };
}

// Function สร้างข้อมูลทดสอบครบทุก payment_status (คืน TicketWorker id ตาม key ของแต่ละแถว)
async function seedDailyWorkerIncome(tx: DbConnection, suffix: string) {
  const admin = await tx.account.create({
    data: {
      username: `dwi-admin-${suffix}`,
      passwordHash: "x",
      role: "admin",
      fullName: `Admin ${suffix}`,
    },
  });
  const gateClient = await tx.gateClient.create({
    data: {
      clientId: `dwi-gate-${suffix}`,
      name: `Gate ${suffix}`,
      secretHash: "x",
    },
  });
  const workers = await Promise.all(
    ["1", "2", "3", "4"].map((index) =>
      tx.masterWorker.create({
        data: {
          laborCode: `DWI${index}-${suffix}`,
          fullName: `Worker ${index} ${suffix}`,
          coatNo: `C${index}-${suffix}`,
          shiftName: index === "4" ? "Evening" : "Morning",
          status: 1,
        },
      }),
    ),
  );
  let sequence = 0;

  // สร้างงานรถ + ticket_no + TicketWorker + assignment หนึ่งแถว
  // ตลาดที่ปิดยอดแล้วจะมี worker snapshot ของแผงด้วย เว้นแต่ระบุ inBooth = false
  async function addRow(input: {
    workerIndex: number;
    marketStatus: string;
    ticketWorkerStatus: string;
    finalEarningAmount?: string;
    acceptedAt: Date | null;
    releasedAt?: Date;
    completedAt?: Date;
    joinedAt?: Date;
    boothStatus?: string;
    inBooth?: boolean;
  }) {
    sequence += 1;
    const key = `${suffix}-${sequence}`;
    const ticketJob = await tx.ticketJob.create({
      data: {
        ticketNumber: `DWI-TN-${key}`,
        licensePlate: `PL-${key}`,
        workersRequired: 1,
        status: input.marketStatus,
        driverQrToken: `DWI-QR-${key}`,
      },
    });
    const marketJob = await tx.marketJob.create({
      data: {
        ticketJobId: ticketJob.id,
        ticketNo: `DWI-NO-${key}`,
        ticketCreatedAt: at("07:00"),
        gateTransactionRef: `DWI-REF-${key}`,
        workersRequired: 1,
        marketCode: "MKT1",
        marketName: "Market 1",
        status: input.marketStatus,
      },
    });

    const boothJob = await tx.boothJob.create({
      data: {
        ticketJobId: ticketJob.id,
        marketJobId: marketJob.id,
        boothCode: `B-${key}`,
        status: input.boothStatus ?? TICKET_STATUS.WAIT,
      },
    });

    const worker = workers[input.workerIndex - 1];

    await tx.ticketJobAssignment.create({
      data: {
        ticketJobId: ticketJob.id,
        workerId: worker.id,
        status: "SCANNED",
        acceptedAt: input.acceptedAt,
        releasedAt: input.releasedAt ?? null,
      },
    });

    const ticketWorker = await tx.ticketWorker.create({
      data: {
        marketJobId: marketJob.id,
        workerId: worker.id,
        status: input.ticketWorkerStatus,
        finalEarningAmount: input.finalEarningAmount ?? null,
        joinedAt: input.joinedAt ?? at("07:30"),
        completedAt: input.completedAt ?? null,
      },
    });

    if (input.marketStatus === VEHICLE_JOB_STATUS.COMPLETED && input.inBooth !== false) {
      await tx.workerSnapshot.create({
        data: { boothJobId: boothJob.id, ticketWorkerId: ticketWorker.id },
      });
    }

    return { ticketWorkerId: ticketWorker.id, ticketJob, marketJob };
  }

  const success = await addRow({
    workerIndex: 1,
    marketStatus: VEHICLE_JOB_STATUS.COMPLETED,
    ticketWorkerStatus: TICKET_WORKER_STATUS.COMPLETED,
    finalEarningAmount: "100.25",
    acceptedAt: at("08:00"),
    completedAt: at("12:00"),
  });
  const partiallyPaid = await addRow({
    workerIndex: 2,
    marketStatus: VEHICLE_JOB_STATUS.COMPLETED,
    ticketWorkerStatus: TICKET_WORKER_STATUS.CANCELLED,
    finalEarningAmount: "50.10",
    acceptedAt: at("09:00"),
  });

  // ถูกถอดจาก ticket_no ที่เสร็จแล้วแต่ไม่ได้เงิน → ไม่เข้าสถานะไหน
  await addRow({
    workerIndex: 3,
    marketStatus: VEHICLE_JOB_STATUS.COMPLETED,
    ticketWorkerStatus: TICKET_WORKER_STATUS.CANCELLED,
    finalEarningAmount: "0.00",
    acceptedAt: at("09:30"),
  });

  const workerReject = await addRow({
    workerIndex: 1,
    marketStatus: VEHICLE_JOB_STATUS.WORKING,
    ticketWorkerStatus: TICKET_WORKER_STATUS.WORKING,
    acceptedAt: at("10:00"),
    boothStatus: TICKET_STATUS.REJECT,
  });
  const adminReject = await addRow({
    workerIndex: 2,
    marketStatus: VEHICLE_JOB_STATUS.WORKING,
    ticketWorkerStatus: TICKET_WORKER_STATUS.WORKING,
    acceptedAt: at("10:00"),
    releasedAt: at("10:30"),
    boothStatus: TICKET_STATUS.REJECT,
  });
  const cancelByAdmin = await addRow({
    workerIndex: 3,
    marketStatus: VEHICLE_JOB_STATUS.CANCELLED,
    ticketWorkerStatus: TICKET_WORKER_STATUS.CANCELLED,
    finalEarningAmount: "30.00",
    acceptedAt: at("11:00"),
  });
  const cancelByAdminLog = await tx.adminActionLog.create({
    data: {
      ticketJobId: cancelByAdmin.ticketJob.id,
      marketJobId: cancelByAdmin.marketJob.id,
      actionType: ADMIN_ACTION_TYPE.MARKET_JOB_CANCELLED,
      actorAccountId: admin.id,
    },
  });
  const cancelByGate = await addRow({
    workerIndex: 4,
    marketStatus: VEHICLE_JOB_STATUS.CANCELLED,
    ticketWorkerStatus: TICKET_WORKER_STATUS.CANCELLED,
    acceptedAt: null,
  });
  const cancelByGateLog = await tx.adminActionLog.create({
    data: {
      ticketJobId: cancelByGate.ticketJob.id,
      actionType: ADMIN_ACTION_TYPE.VEHICLE_JOB_CANCELLED,
      actorGateClientId: gateClient.id,
    },
  });
  const cancelUnknown = await addRow({
    workerIndex: 4,
    marketStatus: VEHICLE_JOB_STATUS.CANCELLED,
    ticketWorkerStatus: TICKET_WORKER_STATUS.CANCELLED,
    acceptedAt: null,
  });

  // log ส่งยอดแทนต้องไม่ถูกหยิบมาเป็นผู้ยกเลิก (regression: fallback adminActionLogs[0])
  await tx.adminActionLog.create({
    data: {
      marketJobId: cancelUnknown.marketJob.id,
      actionType: ADMIN_ACTION_TYPE.OVERRIDE_COUNT,
      actorAccountId: admin.id,
    },
  });

  // ยังทำงานอยู่ ไม่มี reject → ไม่เข้าสถานะไหน
  await addRow({
    workerIndex: 1,
    marketStatus: VEHICLE_JOB_STATUS.WORKING,
    ticketWorkerStatus: TICKET_WORKER_STATUS.WORKING,
    acceptedAt: at("13:00"),
  });

  // อยู่นอกช่วงวันที่ (เสร็จวันก่อนหน้า)
  await addRow({
    workerIndex: 1,
    marketStatus: VEHICLE_JOB_STATUS.COMPLETED,
    ticketWorkerStatus: TICKET_WORKER_STATUS.COMPLETED,
    finalEarningAmount: "999.00",
    acceptedAt: new Date(DAY_START.getTime() - 60 * 60 * 1000),
    joinedAt: new Date(DAY_START.getTime() - 60 * 60 * 1000),
    completedAt: new Date(DAY_START.getTime() - 1),
  });

  return {
    workers,
    ids: {
      success: success.ticketWorkerId,
      partiallyPaid: partiallyPaid.ticketWorkerId,
      workerReject: workerReject.ticketWorkerId,
      adminReject: adminReject.ticketWorkerId,
      cancelByAdmin: cancelByAdmin.ticketWorkerId,
      cancelByGate: cancelByGate.ticketWorkerId,
      cancelUnknown: cancelUnknown.ticketWorkerId,
    },
    plates: {
      partiallyPaid: partiallyPaid.ticketJob.licensePlate,
    },
    ticketNos: {
      adminReject: adminReject.marketJob.ticketNo,
    },
    logs: {
      cancelByAdmin: cancelByAdminLog.id,
      cancelByGate: cancelByGateLog.id,
    },
  };
}

// Function ดึง id ของแถวทุกหน้าตามลำดับ
async function collectAllPages(
  tx: DbConnection,
  filters: DailyWorkerIncomeFilters,
): Promise<number[]> {
  const ids: number[] = [];

  for (let page = 1; ; page += 1) {
    const result = await adminJobsRepository.listDailyWorkerIncome({ ...filters, page }, tx);

    ids.push(...result.rows.map((row) => row.record.id));

    if (result.rows.length < filters.limit) {
      return ids;
    }
  }
}

/* -------------------------------------- Tests -------------------------------------- */

test(
  "adminJobsRepository.listDailyWorkerIncome derives payment_status, filters, sorts, paginates and summarizes in SQL",
  {
    skip: runDbTests
      ? false
      : "Set RUN_DB_TESTS=1 and run PostgreSQL migration before this test.",
  },
  async () => {
    assertSafeTestDatabaseUrl();

    const suffix = Date.now().toString(36);

    await runRollbackTest(async (tx) => {
      const { workers, ids, plates, ticketNos, logs } = await seedDailyWorkerIncome(tx, suffix);
      // จำกัดเฉพาะข้อมูลของ test นี้ด้วย search ที่มี suffix ร่วมกัน (ticket_no/plate/code/ชื่อ/เบอร์เสื้อมี suffix ทั้งหมด)
      const scoped = (overrides: Partial<DailyWorkerIncomeFilters> = {}) =>
        buildFilters({ search: suffix, ...overrides });

      // ทุกแถวหลังกรอง เรียง newest: accepted_at DESC NULLS LAST แล้ว id DESC
      const newestOrder = [
        ids.cancelByAdmin,
        ids.adminReject,
        ids.workerReject,
        ids.partiallyPaid,
        ids.success,
        ids.cancelUnknown,
        ids.cancelByGate,
      ];
      const oldestOrder = [
        ids.success,
        ids.partiallyPaid,
        ids.workerReject,
        ids.adminReject,
        ids.cancelByAdmin,
        ids.cancelByGate,
        ids.cancelUnknown,
      ];

      const all = await adminJobsRepository.listDailyWorkerIncome(scoped(), tx);

      assert.deepEqual(all.rows.map((row) => row.record.id), newestOrder);
      assert.deepEqual(
        Object.fromEntries(all.rows.map((row) => [row.record.id, row.payment_status])),
        {
          [ids.success]: "success",
          [ids.partiallyPaid]: "partially_paid",
          [ids.workerReject]: "worker_reject",
          [ids.adminReject]: "admin_reject",
          [ids.cancelByAdmin]: "cancel",
          [ids.cancelByGate]: "cancel",
          [ids.cancelUnknown]: "cancel",
        },
      );
      assert.deepEqual(
        Object.fromEntries(all.rows.map((row) => [row.record.id, row.cancel_log_id])),
        {
          [ids.success]: null,
          [ids.partiallyPaid]: null,
          [ids.workerReject]: null,
          [ids.adminReject]: null,
          [ids.cancelByAdmin]: logs.cancelByAdmin,
          [ids.cancelByGate]: logs.cancelByGate,
          [ids.cancelUnknown]: null,
        },
      );
      // payable รวมเฉพาะ success/partially_paid (cancel ที่มี final_earning_amount ไม่นับ)
      assert.equal(all.summary.row_count, 7);
      assert.equal(all.summary.worker_count, 4);
      assert.equal(all.summary.payable_total.toFixed(2), "150.35");
      assert.equal(all.summary.needs_review_count, 2);
      assert.deepEqual(all.available_worker_codes, workers.map((worker) => worker.laborCode).sort());
      assert.deepEqual(all.available_shifts, ["Evening", "Morning"]);

      // เรียงทั้งชุดก่อนแบ่งหน้า: รวมทุกหน้าแล้วต้องได้ลำดับเดียวกับชุดเต็ม และ summary เท่ากันทุกหน้า
      assert.deepEqual(await collectAllPages(tx, scoped({ limit: 3 })), newestOrder);
      assert.deepEqual(
        await collectAllPages(tx, scoped({ limit: 3, sortOrder: "oldest" })),
        oldestOrder,
      );

      const secondPage = await adminJobsRepository.listDailyWorkerIncome(scoped({ limit: 3, page: 2 }), tx);

      assert.deepEqual(secondPage.rows.map((row) => row.record.id), newestOrder.slice(3, 6));
      assert.deepEqual(secondPage.summary, all.summary);

      // หน้าที่เกินข้อมูล: ไม่มีแถว แต่ summary ยังเป็นยอดทั้งหมด
      const emptyPage = await adminJobsRepository.listDailyWorkerIncome(scoped({ limit: 3, page: 10 }), tx);

      assert.deepEqual(emptyPage.rows, []);
      assert.deepEqual(emptyPage.summary, all.summary);

      // payment_status แต่ละค่า
      for (const [paymentStatus, expected] of [
        ["success", [ids.success]],
        ["partially_paid", [ids.partiallyPaid]],
        ["worker_reject", [ids.workerReject]],
        ["admin_reject", [ids.adminReject]],
        ["cancel", [ids.cancelByAdmin, ids.cancelUnknown, ids.cancelByGate]],
      ] as const) {
        const result = await adminJobsRepository.listDailyWorkerIncome(scoped({ paymentStatus }), tx);

        assert.deepEqual(result.rows.map((row) => row.record.id), expected, paymentStatus);
        assert.equal(result.summary.row_count, expected.length, paymentStatus);
      }

      // cancelled_by_type ตาม role ของ actor / gate / ไม่พบ log จริง
      for (const [cancelledByType, expected] of [
        ["admin", [ids.cancelByAdmin]],
        ["gate", [ids.cancelByGate]],
        ["unknown", [ids.cancelUnknown]],
      ] as const) {
        const result = await adminJobsRepository.listDailyWorkerIncome(scoped({ cancelledByType }), tx);

        assert.deepEqual(result.rows.map((row) => row.record.id), expected, cancelledByType);
        assert.equal(result.summary.row_count, expected.length, cancelledByType);
        assert.equal(result.summary.payable_total.toFixed(2), "0.00", cancelledByType);
      }

      // search ต้องทำงานร่วมกับช่วงวันที่ (regression: OR ของ search ถูก OR ของช่วงวันที่ทับ)
      for (const [search, expected] of [
        [plates.partiallyPaid.toLowerCase(), [ids.partiallyPaid]],
        [ticketNos.adminReject.toLowerCase(), [ids.adminReject]],
        [`c4-${suffix}`, [ids.cancelUnknown, ids.cancelByGate]],
        [`worker 3 ${suffix}`, [ids.cancelByAdmin]],
      ] as const) {
        const result = await adminJobsRepository.listDailyWorkerIncome(buildFilters({ search }), tx);

        assert.deepEqual(result.rows.map((row) => row.record.id), expected, search);
        assert.equal(result.summary.row_count, expected.length, search);
      }

      // filter ร่วมกัน: worker_code + payment_status และ shift + cancelled_by_type
      const workerOneRejects = await adminJobsRepository.listDailyWorkerIncome(
        scoped({ workerCode: workers[0].laborCode.toLowerCase(), paymentStatus: "worker_reject" }),
        tx,
      );

      assert.deepEqual(workerOneRejects.rows.map((row) => row.record.id), [ids.workerReject]);
      assert.equal(workerOneRejects.summary.worker_count, 1);
      assert.equal(workerOneRejects.summary.needs_review_count, 1);
      // dropdown ไม่ถูกจำกัดด้วย worker_code ของตัวเอง แต่ถูกจำกัดด้วย payment_status
      assert.deepEqual(workerOneRejects.available_worker_codes, [workers[0].laborCode]);

      const eveningGate = await adminJobsRepository.listDailyWorkerIncome(
        scoped({ shift: "Evening", cancelledByType: "gate" }),
        tx,
      );

      assert.deepEqual(eveningGate.rows.map((row) => row.record.id), [ids.cancelByGate]);
      assert.deepEqual(eveningGate.available_shifts, ["Evening"]);

      // ไม่มีข้อมูลตรง filter
      const none = await adminJobsRepository.listDailyWorkerIncome(
        scoped({ shift: "Evening", paymentStatus: "success" }),
        tx,
      );

      assert.deepEqual(none.rows, []);
      assert.deepEqual(
        { ...none.summary, payable_total: none.summary.payable_total.toFixed(2) },
        { row_count: 0, worker_count: 0, payable_total: "0.00", needs_review_count: 0 },
      );
    });
  },
);

// Function สร้างงานที่ ticket_no ปิดยอดแล้ว 2 แผง (เลือกได้ว่ากี่แผงที่ worker อยู่ใน submission worker snapshot)
async function seedClosedTwoBoothMarket(
  tx: DbConnection,
  input: {
    suffix: string;
    key: string;
    workerId: number;
    ticketWorkerStatus: string;
    finalEarningAmount: string;
    submittedBoothCount: number;
  },
) {
  const key = `${input.suffix}-${input.key}`;
  const ticketJob = await tx.ticketJob.create({
    data: {
      ticketNumber: `DWR-TN-${key}`,
      licensePlate: `PR-${key}`,
      workersRequired: 1,
      status: VEHICLE_JOB_STATUS.COMPLETED,
      driverQrToken: `DWR-QR-${key}`,
    },
  });
  const marketJob = await tx.marketJob.create({
    data: {
      ticketJobId: ticketJob.id,
      ticketNo: `DWR-NO-${key}`,
      ticketCreatedAt: at("07:00"),
      gateTransactionRef: `DWR-REF-${key}`,
      workersRequired: 1,
      marketCode: "MKT1",
      marketName: "Market 1",
      status: VEHICLE_JOB_STATUS.COMPLETED,
    },
  });

  await tx.ticketJobAssignment.create({
    data: {
      ticketJobId: ticketJob.id,
      workerId: input.workerId,
      status: "COMPLETED",
      acceptedAt: at("08:00"),
    },
  });

  const ticketWorker = await tx.ticketWorker.create({
    data: {
      marketJobId: marketJob.id,
      workerId: input.workerId,
      status: input.ticketWorkerStatus,
      finalEarningAmount: input.finalEarningAmount,
      joinedAt: at("07:30"),
      completedAt: at("12:00"),
    },
  });
  const booths = [];

  for (const index of [1, 2]) {
    const booth = await tx.boothJob.create({
      data: {
        ticketJobId: ticketJob.id,
        marketJobId: marketJob.id,
        boothCode: `BR${index}-${key}`,
        status: TICKET_STATUS.COMPLETED,
        financializedAt: at("11:00"),
      },
    });

    // แผงที่ submission ไม่มีชื่อ worker = ไม่เคยมีสิทธิ์รับเงินแผงนั้น
    if (index <= input.submittedBoothCount) {
      const submission = await tx.ticketCompletionSubmission.create({
        data: {
          ticketId: booth.id,
          submittedByRole: "worker",
          submittedByWorkerId: input.workerId,
          status: "CONFIRMED",
          workerCountSnapshot: 1,
        },
      });

      await tx.workerSnapshot.create({
        data: {
          submissionId: submission.id,
          ticketWorkerId: ticketWorker.id,
        },
      });
    }

    booths.push(booth);
  }

  return { ticketJob, marketJob, ticketWorker, booths };
}

test(
  "adminJobsRepository.listDailyWorkerIncome derives cancel/partially_paid/success from current payout exclusions of submitted booths",
  {
    skip: runDbTests
      ? false
      : "Set RUN_DB_TESTS=1 and run PostgreSQL migration before this test.",
  },
  async () => {
    assertSafeTestDatabaseUrl();

    const suffix = `r${Date.now().toString(36)}`;

    await runRollbackTest(async (tx) => {
      const admin = await tx.account.create({
        data: {
          username: `dwr-admin-${suffix}`,
          passwordHash: "x",
          role: "admin",
          fullName: `Admin ${suffix}`,
        },
      });
      const worker = await tx.masterWorker.create({
        data: {
          laborCode: `DWR-${suffix}`,
          fullName: `Worker ${suffix}`,
          shiftName: "Morning",
          status: 1,
        },
      });
      // log ถอดแรงงานของ ticket_no (ใช้ตรวจว่าเลือก log ล่าสุดที่ตรง worker)
      const createRemovalLog = (
        seeded: Awaited<ReturnType<typeof seedClosedTwoBoothMarket>>,
        actionType: string,
        workerId: number,
        createdAt: Date,
      ) =>
        tx.adminActionLog.create({
          data: {
            ticketJobId: seeded.ticketJob.id,
            marketJobId: seeded.marketJob.id,
            boothJobId:
              actionType === ADMIN_ACTION_TYPE.TICKET_WORKER_CANCELLED_FROM_BOOTH ? seeded.booths[0].id : null,
            actionType,
            actorAccountId: admin.id,
            metadata: { worker_id: workerId, worker_code: worker.laborCode },
            createdAt,
          },
        });

      // COMPLETED + ถอดครบทุกแผงที่ปิดยอด + Payable=0 → cancel พร้อม log ถอดล่าสุดของ worker นี้
      const removedAll = await seedClosedTwoBoothMarket(tx, {
        suffix,
        key: "all",
        workerId: worker.id,
        ticketWorkerStatus: TICKET_WORKER_STATUS.COMPLETED,
        finalEarningAmount: "0.00",
        submittedBoothCount: 2,
      });

      for (const booth of removedAll.booths) {
        await tx.boothJobWorkerExclusion.create({
          data: { boothJobId: booth.id, ticketWorkerId: removedAll.ticketWorker.id },
        });
      }

      await createRemovalLog(removedAll, ADMIN_ACTION_TYPE.TICKET_WORKER_CANCELLED_FROM_BOOTH, worker.id, at("12:30"));

      const removedAllLog = await createRemovalLog(
        removedAll,
        ADMIN_ACTION_TYPE.TICKET_WORKER_CANCELLED_FROM_BOOTH,
        worker.id,
        at("12:40"),
      );

      // log ของ worker คนอื่นที่ใหม่กว่าต้องไม่ถูกหยิบ
      await createRemovalLog(removedAll, ADMIN_ACTION_TYPE.TICKET_WORKER_CANCELLED, worker.id + 1_000_000, at("12:50"));

      // ถอดบางแผง + Payable>0 → partially_paid
      const removedSome = await seedClosedTwoBoothMarket(tx, {
        suffix,
        key: "some",
        workerId: worker.id,
        ticketWorkerStatus: TICKET_WORKER_STATUS.COMPLETED,
        finalEarningAmount: "40.00",
        submittedBoothCount: 2,
      });

      await tx.boothJobWorkerExclusion.create({
        data: { boothJobId: removedSome.booths[0].id, ticketWorkerId: removedSome.ticketWorker.id },
      });
      await createRemovalLog(removedSome, ADMIN_ACTION_TYPE.TICKET_WORKER_CANCELLED_FROM_BOOTH, worker.id, at("12:30"));

      // นำกลับครบทุกแผงแล้ว (exclusion ถูกลบ เหลือแค่ log) → success
      const restored = await seedClosedTwoBoothMarket(tx, {
        suffix,
        key: "restored",
        workerId: worker.id,
        ticketWorkerStatus: TICKET_WORKER_STATUS.COMPLETED,
        finalEarningAmount: "80.00",
        submittedBoothCount: 2,
      });

      await createRemovalLog(restored, ADMIN_ACTION_TYPE.TICKET_WORKER_CANCELLED_FROM_BOOTH, worker.id, at("12:30"));

      // ถูกเตะตอน WORKING ได้ 0 บาท และไม่เคยอยู่ใน submission snapshot → ซ่อนจากรายงานเหมือนเดิม
      const kickedBeforeSubmit = await seedClosedTwoBoothMarket(tx, {
        suffix,
        key: "kicked",
        workerId: worker.id,
        ticketWorkerStatus: TICKET_WORKER_STATUS.CANCELLED,
        finalEarningAmount: "0.00",
        submittedBoothCount: 0,
      });

      for (const booth of kickedBeforeSubmit.booths) {
        await tx.boothJobWorkerExclusion.create({
          data: { boothJobId: booth.id, ticketWorkerId: kickedBeforeSubmit.ticketWorker.id },
        });
      }

      await createRemovalLog(kickedBeforeSubmit, ADMIN_ACTION_TYPE.TICKET_WORKER_CANCELLED, worker.id, at("09:00"));

      const scoped = (overrides: Partial<DailyWorkerIncomeFilters> = {}) =>
        buildFilters({ search: `DWR-NO-${suffix}`, ...overrides });
      const all = await adminJobsRepository.listDailyWorkerIncome(scoped(), tx);

      assert.deepEqual(
        Object.fromEntries(
          all.rows.map((row) => [
            row.record.id,
            [row.payment_status, row.cancel_log_id, row.removed_from_submitted_booth],
          ]),
        ),
        {
          [removedAll.ticketWorker.id]: ["cancel", removedAllLog.id, true],
          [removedSome.ticketWorker.id]: ["partially_paid", null, true],
          [restored.ticketWorker.id]: ["success", null, false],
        },
      );
      // ยอดจ่ายไม่รวมแถว cancel
      assert.equal(all.summary.row_count, 3);
      assert.equal(all.summary.payable_total.toFixed(2), "120.00");

      // ตัวกรอง payment_status / cancelled_by_type และ summary ใช้สถานะชุดเดียวกัน
      for (const [filters, expected, payableTotal] of [
        [{ paymentStatus: "cancel" }, [removedAll.ticketWorker.id], "0.00"],
        [{ paymentStatus: "partially_paid" }, [removedSome.ticketWorker.id], "40.00"],
        [{ paymentStatus: "success" }, [restored.ticketWorker.id], "80.00"],
        [{ cancelledByType: "admin" }, [removedAll.ticketWorker.id], "0.00"],
      ] as const) {
        const result = await adminJobsRepository.listDailyWorkerIncome(scoped(filters), tx);

        assert.deepEqual(result.rows.map((row) => row.record.id), expected, JSON.stringify(filters));
        assert.equal(result.summary.row_count, expected.length, JSON.stringify(filters));
        assert.equal(result.summary.payable_total.toFixed(2), payableTotal, JSON.stringify(filters));
      }

      // นำกลับครบทุกแผงของแถวที่ถูกถอดครบ → กลับเป็น success
      await tx.boothJobWorkerExclusion.deleteMany({
        where: { ticketWorkerId: removedAll.ticketWorker.id },
      });
      await tx.ticketWorker.update({
        where: { id: removedAll.ticketWorker.id },
        data: { finalEarningAmount: "60.00" },
      });

      const afterRestore = await adminJobsRepository.listDailyWorkerIncome(
        scoped({ paymentStatus: "success" }),
        tx,
      );

      assert.deepEqual(
        afterRestore.rows.map((row) => row.record.id).sort((left, right) => left - right),
        [removedAll.ticketWorker.id, restored.ticketWorker.id].sort((left, right) => left - right),
      );
      assert.equal(afterRestore.summary.payable_total.toFixed(2), "140.00");
    });
  },
);

test(
  "adminJobsRepository.listDailyWorkerIncome lists COMPLETED markets only for TicketWorkers with booth evidence (worker snapshot or payment)",
  {
    skip: runDbTests
      ? false
      : "Set RUN_DB_TESTS=1 and run PostgreSQL migration before this test.",
  },
  async () => {
    assertSafeTestDatabaseUrl();

    const suffix = `s${Date.now().toString(36)}`;

    await runRollbackTest(async (tx) => {
      const [substitute, snapshotWorker, paymentWorker] = await Promise.all(
        ["1", "2", "3"].map((index) =>
          tx.masterWorker.create({
            data: {
              laborCode: `DWS${index}-${suffix}`,
              fullName: `Worker ${index} ${suffix}`,
              shiftName: "Morning",
              status: 1,
            },
          }),
        ),
      );
      let sequence = 0;

      // สร้างงานรถ (ไม่มี MarketJob) + assignment ของ worker ที่ระบุ
      async function addTicketJob(workerIds: number[]) {
        sequence += 1;
        const key = `${suffix}-${sequence}`;
        const ticketJob = await tx.ticketJob.create({
          data: {
            ticketNumber: `DWS-TN-${key}`,
            licensePlate: `PS-${key}`,
            workersRequired: workerIds.length,
            status: VEHICLE_JOB_STATUS.COMPLETED,
            driverQrToken: `DWS-QR-${key}`,
          },
        });

        for (const workerId of workerIds) {
          await tx.ticketJobAssignment.create({
            data: { ticketJobId: ticketJob.id, workerId, status: "COMPLETED", acceptedAt: at("08:00") },
          });
        }

        return ticketJob;
      }

      // สร้าง MarketJob ที่ปิดยอดแล้ว 1 แผง + TicketWorker COMPLETED ของ worker นั้น
      async function addClosedMarket(ticketJobId: number, workerId: number, finalEarningAmount: string) {
        sequence += 1;
        const key = `${suffix}-${sequence}`;
        const marketJob = await tx.marketJob.create({
          data: {
            ticketJobId,
            ticketNo: `DWS-NO-${key}`,
            ticketCreatedAt: at("07:00"),
            gateTransactionRef: `DWS-REF-${key}`,
            workersRequired: 1,
            marketCode: "MKT1",
            marketName: "Market 1",
            status: VEHICLE_JOB_STATUS.COMPLETED,
          },
        });
        const booth = await tx.boothJob.create({
          data: {
            ticketJobId,
            marketJobId: marketJob.id,
            boothCode: `BS-${key}`,
            status: TICKET_STATUS.COMPLETED,
            financializedAt: at("11:00"),
          },
        });
        const ticketWorker = await tx.ticketWorker.create({
          data: {
            marketJobId: marketJob.id,
            workerId,
            status: TICKET_WORKER_STATUS.COMPLETED,
            finalEarningAmount,
            joinedAt: at("07:30"),
            completedAt: at("12:00"),
          },
        });

        return { marketJob, booth, ticketWorker };
      }

      // แรงงานทดแทนสแกนรถที่มี 2 ตลาด: roster sync สร้าง TicketWorker ทั้ง A และ B แต่มีชื่อใน submission ของ A เท่านั้น
      const substituteJob = await addTicketJob([substitute.id]);
      const marketA = await addClosedMarket(substituteJob.id, substitute.id, "7.50");
      const marketB = await addClosedMarket(substituteJob.id, substitute.id, "0.00");
      const submissionA = await tx.ticketCompletionSubmission.create({
        data: {
          ticketId: marketA.booth.id,
          submittedByRole: "worker",
          submittedByWorkerId: substitute.id,
          status: "CONFIRMED",
          workerCountSnapshot: 1,
        },
      });

      await tx.workerSnapshot.create({
        data: { submissionId: submissionA.id, ticketWorkerId: marketA.ticketWorker.id },
      });

      // อยู่ใน confirm snapshot จริงแต่ยอด 0.00 (อัตราหรือยอดสินค้าเป็นศูนย์) → ยังเป็น success
      const snapshotZero = await addClosedMarket((await addTicketJob([snapshotWorker.id])).id, snapshotWorker.id, "0.00");

      await tx.workerSnapshot.create({
        data: { boothJobId: snapshotZero.booth.id, ticketWorkerId: snapshotZero.ticketWorker.id },
      });

      // มีแค่ ticket_worker_payments ยอด 0.00 → ยังเป็น success
      const paymentZero = await addClosedMarket((await addTicketJob([paymentWorker.id])).id, paymentWorker.id, "0.00");
      const product = await tx.ticketProduct.create({
        data: {
          ticketId: paymentZero.booth.id,
          productCode: `P-${suffix}`,
          productName: "Apple",
          packageCode: "box",
          packageName: "Box",
          quantity: "0",
          requiredWorkerCountSnapshot: 1,
        },
      });
      const financial = await tx.ticketProductFinancial.create({
        data: {
          ticketProductId: product.id,
          confirmedQuantity: "0",
          workerCount: 1,
          workerPayoutTotal: "0",
          fundAmount: "0",
          finalizedAt: at("11:00"),
          shirtColorSnapshot: "RED",
        },
      });

      await tx.ticketWorkerPayment.create({
        data: {
          ticketProductFinancialId: financial.id,
          ticketWorkerId: paymentZero.ticketWorker.id,
          rawAmount: "0",
          remainderAmount: "0",
          finalAmount: "0.00",
        },
      });

      // COMPLETED + 0.00 โดยไม่มี snapshot/payment เลย → ไม่แสดง
      const noEvidence = await addClosedMarket((await addTicketJob([snapshotWorker.id])).id, snapshotWorker.id, "0.00");

      const scoped = (overrides: Partial<DailyWorkerIncomeFilters> = {}) =>
        buildFilters({ search: `DWS-NO-${suffix}`, ...overrides });
      const all = await adminJobsRepository.listDailyWorkerIncome(scoped(), tx);
      const visibleIds = [marketA.ticketWorker.id, snapshotZero.ticketWorker.id, paymentZero.ticketWorker.id];

      assert.deepEqual(
        Object.fromEntries(all.rows.map((row) => [row.record.id, row.payment_status])),
        Object.fromEntries(visibleIds.map((id) => [id, "success"])),
      );
      assert.ok(!all.rows.some((row) => row.record.id === marketB.ticketWorker.id));
      assert.ok(!all.rows.some((row) => row.record.id === noEvidence.ticketWorker.id));
      assert.deepEqual(
        { ...all.summary, payable_total: all.summary.payable_total.toFixed(2) },
        { row_count: 3, worker_count: 3, payable_total: "7.50", needs_review_count: 0 },
      );
      assert.deepEqual(
        all.available_worker_codes,
        [substitute.laborCode, snapshotWorker.laborCode, paymentWorker.laborCode].sort(),
      );

      // ตลาด B ของแรงงานทดแทนไม่อยู่ใน payment_status ใดเลย และ pagination นับเฉพาะแถวที่เหลือ
      const substituteRows = await adminJobsRepository.listDailyWorkerIncome(
        scoped({ workerCode: substitute.laborCode }),
        tx,
      );

      assert.deepEqual(substituteRows.rows.map((row) => row.record.marketJobId), [marketA.marketJob.id]);
      assert.equal(substituteRows.summary.row_count, 1);

      const successPages = await collectAllPages(tx, scoped({ paymentStatus: "success", limit: 2 }));

      assert.deepEqual(
        [...successPages].sort((left, right) => left - right),
        [...visibleIds].sort((left, right) => left - right),
      );
    });
  },
);
