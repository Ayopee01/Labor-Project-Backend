// Import Config
import { MASTER_MARKET_ACTIVE_STATUS, MASTER_OWNER_STALL_ACTIVE_STATUS, SCANNED_ASSIGNMENT_STATUSES, TERMINAL_TICKET_STATUSES, TICKET_STATUS, TICKET_SUBMITTER_ROLE, TICKET_WORKER_STATUS } from "../../constants/status";
// Import Mappers
import { mapBoothJob, mapTicketCompletionSubmission, mapTicketProduct } from "./mappers";
import { client, requireDto } from "./repository-utils";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";
import type { BoothJobDto, TicketCompletionSubmissionDto, TicketProductConfirmationInput, TicketProductDto, VendorLineTargetDto } from "../../types/worker.type";

// Class error สำหรับ race ตอน Vendor action ถูก resolve ไปแล้ว
export class TicketSubmissionAlreadyResolvedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketSubmissionAlreadyResolvedError";
  }
}

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจว่า Business Ticket เคยมี Booth ถูกส่งยอดแล้วหรือไม่
export async function hasSubmittedActiveTicketsForMarketJob(
  marketJobId: number,
  connection?: DbConnection
): Promise<boolean> {
  const db = client(connection);
  const count = await db.boothJob.count({
    where: {
      marketJobId,
      status: {
        in: [TICKET_STATUS.DELIVERED, TICKET_STATUS.REJECT],
      },
    },
  });

  return count > 0;
}

// Function เช็คว่า worker ถูกถอดออกจาก Booth นี้ไปแล้วหรือยัง
export async function findBoothJobWorkerExclusion(
  boothJobId: number,
  ticketWorkerId: number,
  connection?: DbConnection
): Promise<boolean> {
  const db = client(connection);
  const exclusion = await db.boothJobWorkerExclusion.findUnique({
    where: {
      boothJobId_ticketWorkerId: {
        boothJobId,
        ticketWorkerId,
      },
    },
  });

  return exclusion !== null;
}

// Function นับ worker ที่ยังนับเป็นคนหารเงินของ Booth นี้ (status WORKING และไม่ถูก exclude จาก Booth นี้)
// Filter ต้องตรงกับ query ใน confirmTicketCompletion เพื่อเช็คก่อนว่า exclude แล้วจะเหลือ 0 คนหรือไม่
export async function countEligibleWorkersForBooth(
  marketJobId: number,
  boothJobId: number,
  connection?: DbConnection
): Promise<number> {
  const db = client(connection);

  return db.ticketWorker.count({
    where: {
      marketJobId,
      status: TICKET_WORKER_STATUS.WORKING,
      boothExclusions: {
        none: {
          boothJobId,
        },
      },
    },
  });
}

// Function ถอด worker คนหนึ่งออกจาก Booth หนึ่งแผงเดียว (ไม่แตะ TicketWorker.status) จาก DB — ทำให้
// confirmTicketCompletion ไม่นับ worker คนนี้เป็นตัวหารของ Booth นี้อีกต่อไปตอน snapshot ต่อจากนี้
export async function createBoothJobWorkerExclusion(
  boothJobId: number,
  ticketWorkerId: number,
  connection?: DbConnection
): Promise<void> {
  const db = client(connection);

  await db.boothJobWorkerExclusion.create({
    data: {
      boothJobId,
      ticketWorkerId,
    },
  });
}

// Function ค้นหา gate ticket ตาม ID สำหรับส่งยอด
export async function findBoothJobForCompletion(
  ticketId: number,
  connection?: DbConnection
): Promise<BoothJobDto | null> {
  const db = client(connection);
  const ticket = await db.boothJob.findUnique({
    where: {
      id: ticketId,
    },
  });

  return mapBoothJob(ticket);
}

// Function ค้นหา Booth สำหรับส่งยอดโดย scope ด้วย Business Ticket
export async function findBoothJobForCompletionByTicketNumberAndTicketNoAndBoothCode(
  ticketNumber: string,
  ticketNo: string,
  boothCode: string,
  connection?: DbConnection
): Promise<BoothJobDto | null> {
  const db = client(connection);
  const ticket = await db.boothJob.findFirst({
    where: {
      boothCode,
      marketJob: {
        ticketNo,
      },
      ticketJob: {
        ticketNumber,
      },
    },
    orderBy: {
      id: "asc",
    },
  });

  return mapBoothJob(ticket);
}

// Function ค้นหา Booth สำหรับส่งยอดจาก assignment ปัจจุบันของ Worker
export async function findBoothJobForCompletionByTicketJobIdAndTicketNoAndBoothCode(
  ticketJobId: number,
  ticketNo: string,
  boothCode: string,
  connection?: DbConnection
): Promise<BoothJobDto | null> {
  const db = client(connection);
  const ticket = await db.boothJob.findFirst({
    where: {
      boothCode,
      ticketJobId,
      marketJob: {
        ticketNo,
      },
    },
    orderBy: {
      id: "asc",
    },
  });

  return mapBoothJob(ticket);
}

// Function หา BoothJob จาก ticketNo+boothCode หลัง Worker เคย scan
export async function findBoothJobForCompletionByWorkerHistoryAndTicketNoAndBoothCode(
  workerId: number,
  ticketNo: string,
  boothCode: string,
  connection?: DbConnection
): Promise<BoothJobDto | null> {
  const db = client(connection);
  const ticket = await db.boothJob.findFirst({
    where: {
      boothCode,
      marketJob: {
        ticketNo,
      },
      ticketJob: {
        assignments: {
          some: {
            workerId,
            status: {
              in: SCANNED_ASSIGNMENT_STATUSES,
            },
          },
        },
      },
    },
    orderBy: {
      id: "asc",
    },
  });

  return mapBoothJob(ticket);
}

// Function หา LINE target ของแผงในตั๋วนี้ (wrap listActiveVendorLineTargetsByMarketAndBooth ด้วย ticketId)
export async function listActiveVendorLineTargetsForTicket(
  ticketId: number,
  connection?: DbConnection
): Promise<VendorLineTargetDto[]> {
  const db = client(connection);
  const ticket = await db.boothJob.findUnique({
    where: {
      id: ticketId,
    },
    include: {
      marketJob: true,
    },
  });

  if (!ticket) {
    return [];
  }

  return listActiveVendorLineTargetsByMarketAndBooth(
    ticket.marketJob.marketCode,
    ticket.boothCode,
    connection
  );
}

// Function หา LINE target (owner + member) ของแผงหนึ่งใบ ใช้ร่วมกันทั้งจาก ticketId
// (ผ่าน listActiveVendorLineTargetsForTicket) และจาก marketCode+boothCode ตรงๆ ตอนยังไม่มี ticket
export async function listActiveVendorLineTargetsByMarketAndBooth(
  marketCode: string,
  boothCode: string,
  connection?: DbConnection
): Promise<VendorLineTargetDto[]> {
  const db = client(connection);
  const ownerStall = await db.masterOwnerStall.findUnique({
    where: {
      marketCode_boothCode: {
        marketCode,
        boothCode,
      },
    },
  });

  if (
    !ownerStall ||
    ownerStall.status !== MASTER_OWNER_STALL_ACTIVE_STATUS ||
    ownerStall.ownerStatus !== MASTER_MARKET_ACTIVE_STATUS ||
    !ownerStall.lineUserId
  ) {
    return [];
  }

  const members = await db.masterMemberStall.findMany({
    where: {
      marketCode: ownerStall.marketCode,
      ownerIdCard: ownerStall.cardId,
      ownerLineUserId: ownerStall.lineUserId,
      status: MASTER_OWNER_STALL_ACTIVE_STATUS,
      memberStallStatusOnStall: "1",
    },
    orderBy: {
      id: "asc",
    },
  });
  const seen = new Set<string>();
  const targets: VendorLineTargetDto[] = [];
  const addTarget = (lineUserId: string, targetType: VendorLineTargetDto["target_type"]) => {
    if (seen.has(lineUserId)) {
      return;
    }

    seen.add(lineUserId);
    targets.push({
      line_user_id: lineUserId,
      target_type: targetType,
    });
  };

  addTarget(ownerStall.lineUserId, "owner");

  for (const member of members) {
    addTarget(member.memberStallLineUserId, "member");
  }

  return targets;
}

// Function ดึงแผงที่ยัง active (ไม่ COMPLETED/CANCELLED) ทั้งหมดของ Business Ticket (MarketJob) นี้
// เรียกก่อนสั่ง cancelMarketJob เสมอ เพราะ cascade จะทำให้ทุกแผงกลายเป็น CANCELLED ไปด้วย ถ้าไม่ snapshot ไว้ก่อนจะไม่รู้ว่าต้องแจ้ง LINE แผงไหนบ้าง
export async function listActiveBoothsByMarketJobId(
  marketJobId: number,
  connection?: DbConnection
): Promise<Array<{ id: number; boothCode: string; boothName: string | null }>> {
  const db = client(connection);

  return db.boothJob.findMany({
    where: {
      marketJobId,
      status: {
        notIn: TERMINAL_TICKET_STATUSES,
      },
    },
    orderBy: {
      id: "asc",
    },
    select: {
      id: true,
      boothCode: true,
      boothName: true,
    },
  });
}

// Function ดึงแผงที่ยัง active ทั้งหมดของ TicketJob (รถทั้งคัน) นี้ พร้อม ticket_no/marketName ของ Business Ticket ที่แผงนั้นสังกัดอยู่
// เรียกก่อนสั่ง cancelTicketJob เสมอ ด้วยเหตุผลเดียวกับ listActiveBoothsByMarketJobId
export async function listActiveBoothsByTicketJobId(
  ticketJobId: number,
  connection?: DbConnection
): Promise<
  Array<{
    id: number;
    boothCode: string;
    boothName: string | null;
    ticketNo: string;
    marketName: string;
  }>
> {
  const db = client(connection);
  const booths = await db.boothJob.findMany({
    where: {
      ticketJobId,
      status: {
        notIn: TERMINAL_TICKET_STATUSES,
      },
    },
    orderBy: {
      id: "asc",
    },
    include: {
      marketJob: {
        select: {
          ticketNo: true,
          marketName: true,
        },
      },
    },
  });

  return booths.map((booth) => ({
    id: booth.id,
    boothCode: booth.boothCode,
    boothName: booth.boothName,
    ticketNo: booth.marketJob.ticketNo,
    marketName: booth.marketJob.marketName,
  }));
}

// Function ดึงรายการสินค้าในตั๋ว
export async function listTicketProducts(
  ticketId: number,
  connection?: DbConnection
): Promise<TicketProductDto[]> {
  const db = client(connection);
  const products = await db.ticketProduct.findMany({
    where: {
      ticketId,
    },
    orderBy: {
      id: "asc",
    },
  });

  return products
    .map((product) => mapTicketProduct(product))
    .filter((product): product is TicketProductDto => product !== null);
}

// Function ยกเลิก Gate ticket (booth) จาก DB — ไม่แตะ TicketWorker (Worker Roster) เพราะ Roster เป็นระดับ Business Ticket (market job) ไม่ใช่ระดับ Booth
// การยกเลิก Booth เดียวไม่ควรกระทบสมาชิกที่ยังทำ Booth อื่นในใบเดียวกัน
export async function cancelBoothJob(
  ticketId: number,
  connection?: DbConnection
): Promise<BoothJobDto> {
  const db = client(connection);

  const ticket = await db.boothJob.update({
    where: {
      id: ticketId,
    },
    data: {
      status: TICKET_STATUS.CANCELLED,
    },
  });

  return requireDto(mapBoothJob(ticket), "gate ticket cancel");
}

// Function อัปเดตยอดยืนยันของสินค้าในตั๋ว รองรับกรณีเปลี่ยน package (package_switch) ด้วย
export async function updateTicketProductConfirmations(
  ticketId: number,
  items: TicketProductConfirmationInput[],
  connection?: DbConnection
): Promise<TicketProductDto[]> {
  const db = client(connection);

  for (const item of items) {
    // original_package_code คือ packageCode เดิมก่อนเปลี่ยน (ถ้าไม่เปลี่ยนจะเท่ากับ packageCode ที่ส่งมา)
    const originalPackageCode = item.original_package_code ?? item.packageCode;

    const result =
      await db.ticketProduct.updateMany({
        where: {
          ticketId,
          productCode: item.productCode,
          packageCode: originalPackageCode,
        },
        data: {
          confirmedQuantity: item.confirmed_quantity,
          ...(item.package_switch
            ? {
                packageCode: item.packageCode,
                packageName: item.package_switch.packageName,
                packageWeightSnapshot: item.package_switch.packageWeightSnapshot,
                rateIdSnapshot: item.package_switch.rateIdSnapshot,
                sourceRateIdSnapshot: item.package_switch.sourceRateIdSnapshot,
                rateMarketCode: item.package_switch.rateMarketCode,
                rateSource: item.package_switch.rateSource,
                weightRangeName: item.package_switch.weightRangeName,
                weightMinSnapshot: item.package_switch.weightMinSnapshot,
                weightMaxSnapshot: item.package_switch.weightMaxSnapshot,
                stallRateSnapshot: item.package_switch.stallRateSnapshot,
                laborRateSnapshot: item.package_switch.laborRateSnapshot,
                rateSnapshotAt: item.package_switch.rateSnapshotAt,
              }
            : {}),
        },
      });

    if (result.count !== 1) {
      throw new Error(
        "Ticket product confirmation did not update exactly one product."
      );
    }
  }

  return listTicketProducts(
    ticketId,
    connection
  );
}

// Function เปลี่ยนสถานะตั๋วเป็น DELIVERED (จาก WAIT/WORKING/REJECT) และล้าง reject reason
export async function markTicketDelivered(
  ticketId: number,
  connection?: DbConnection
): Promise<boolean> {
  const db = client(connection);
  const result = await db.boothJob.updateMany({
    where: {
      id: ticketId,
      status: {
        in: [TICKET_STATUS.WAIT, TICKET_STATUS.WORKING, TICKET_STATUS.REJECT],
      },
    },
    data: {
      status: TICKET_STATUS.DELIVERED,
      rejectReason: null,
    },
  });

  return result.count === 1;
}

// Function สร้าง submission ส่งยอดของตั๋ว โดยแยก submitter เป็น account (admin) หรือ worker ตาม role
export async function createTicketCompletionSubmission(
  ticketId: number,
  submitterId: number,
  submittedByRole: string,
  workerCountSnapshot: number,
  assignmentId: number | null,
  connection?: DbConnection
): Promise<TicketCompletionSubmissionDto> {
  const db = client(connection);
  const isAdmin = submittedByRole === TICKET_SUBMITTER_ROLE.ADMIN;
  const submission = await db.ticketCompletionSubmission.create({
    data: {
      ticketId,
      submittedByAccountId: isAdmin ? submitterId : null,
      submittedByWorkerId: isAdmin ? null : submitterId,
      submittedByRole,
      status: TICKET_STATUS.DELIVERED,
      workerCountSnapshot,
      assignmentId,
    },
  });

  return requireDto(
    mapTicketCompletionSubmission(submission),
    "ticket completion submission create"
  );
}

// Function บันทึก roster ของ TicketWorker ที่ยัง WORKING ตอน submit จริง ผูกกับ submission นี้
// ต้องเรียกในทรานแซกชันเดียวกับ createTicketCompletionSubmission ด้วย ticketWorkerIds ชุดเดียวกับที่ใช้คำนวณ workerCountSnapshot
export async function createSubmissionWorkerSnapshots(
  submissionId: number,
  ticketWorkerIds: number[],
  connection?: DbConnection
): Promise<void> {
  if (ticketWorkerIds.length === 0) {
    return;
  }

  const db = client(connection);

  await db.workerSnapshot.createMany({
    data: ticketWorkerIds.map((ticketWorkerId) => ({
      submissionId,
      ticketWorkerId,
    })),
    skipDuplicates: true,
  });
}

// Function หา submission ล่าสุดของตั๋วที่ยังสถานะ DELIVERED (รอ confirm/reject)
export async function findWaitingTicketCompletionSubmission(
  ticketId: number,
  connection?: DbConnection
): Promise<TicketCompletionSubmissionDto | null> {
  const db = client(connection);
  const submission = await db.ticketCompletionSubmission.findFirst({
    where: {
      ticketId,
      status: TICKET_STATUS.DELIVERED,
    },
    orderBy: {
      id: "desc",
    },
  });

  return mapTicketCompletionSubmission(submission);
}

// Function หา Booth ที่ค้าง DELIVERED สำหรับ startup recovery
export async function listDeliveredTicketsWithLatestSubmission(
  connection?: DbConnection
): Promise<Array<{ ticket: BoothJobDto; submission: TicketCompletionSubmissionDto }>> {
  const db = client(connection);
  const tickets = await db.boothJob.findMany({
    where: {
      status: TICKET_STATUS.DELIVERED,
    },
    include: {
      completionSubmissions: {
        where: {
          status: TICKET_STATUS.DELIVERED,
        },
        orderBy: {
          id: "desc",
        },
        take: 1,
      },
    },
  });

  const results: Array<{ ticket: BoothJobDto; submission: TicketCompletionSubmissionDto }> = [];

  for (const ticket of tickets) {
    const mappedTicket = mapBoothJob(ticket);
    const mappedSubmission = mapTicketCompletionSubmission(ticket.completionSubmissions[0] ?? null);

    if (mappedTicket && mappedSubmission) {
      results.push({ ticket: mappedTicket, submission: mappedSubmission });
    }
  }

  return results;
}

// Function ค้นหา ticket completion submission ตาม ID จาก DB
export async function findTicketCompletionSubmissionById(
  submissionId: number,
  connection?: DbConnection
): Promise<TicketCompletionSubmissionDto | null> {
  const db = client(connection);
  const submission = await db.ticketCompletionSubmission.findUnique({
    where: {
      id: submissionId,
    },
  });

  return mapTicketCompletionSubmission(submission);
}

// Function ยืนยันปิดงานของตั๋ว (DELIVERED -> COMPLETED) พร้อมบันทึก snapshot worker ที่หารเงินของ Booth นี้
export async function confirmTicketCompletion(
  ticketId: number,
  submissionId: number,
  connection?: DbConnection,
  resolvedByLineUserId?: string | null
): Promise<{
  ticket: BoothJobDto;
  submission: TicketCompletionSubmissionDto;
}> {
  const db = client(connection);
  const completedAt = new Date();
  const updateResult = await db.boothJob.updateMany({
    where: {
      id: ticketId,
      status: TICKET_STATUS.DELIVERED,
    },
    data: {
      status: TICKET_STATUS.COMPLETED,
      completedAt,
    },
  });

  if (updateResult.count !== 1) {
    throw new TicketSubmissionAlreadyResolvedError(
      "Ticket confirm did not update a waiting ticket.",
    );
  }

  // TicketWorker (roster ของ Business Ticket) ไม่ถูกแตะที่นี่ — ปิดเป็น COMPLETED เฉพาะตอน finalizeMarketJobFinancials
  // เพราะ Business Ticket หนึ่งใบอาจมีหลาย Booth และ Booth นี้เป็นเพียงใบเดียวที่จบ

  const [ticket, submission] = await Promise.all([
    db.boothJob.findUnique({
      where: {
        id: ticketId,
      },
    }),
    db.ticketCompletionSubmission.update({
      where: {
        id: submissionId,
      },
      data: {
        status: TICKET_STATUS.COMPLETED,
        confirmedAt: new Date(),
        resolvedByLineUserId: resolvedByLineUserId ?? null,
      },
    }),
  ]);

  if (ticket) {
    // บันทึก snapshot worker ที่ใช้หารเงินของ Booth นี้ ณ เวลา confirm
    const workingWorkers = await db.ticketWorker.findMany({
      where: {
        marketJobId: ticket.marketJobId,
        status: TICKET_WORKER_STATUS.WORKING,
        boothExclusions: {
          none: {
            boothJobId: ticketId,
          },
        },
      },
      select: {
        id: true,
      },
    });

    if (workingWorkers.length > 0) {
      await db.workerSnapshot.createMany({
        data: workingWorkers.map((worker) => ({
          boothJobId: ticketId,
          ticketWorkerId: worker.id,
        })),
        skipDuplicates: true,
      });
    }
  }

  return {
    ticket: requireDto(mapBoothJob(ticket), "ticket confirm"),
    submission: requireDto(
      mapTicketCompletionSubmission(submission),
      "ticket submission confirm"
    ),
  };
}

// Function reject ตั๋วที่ส่งยอด (DELIVERED -> REJECT) พร้อมเหตุผล
export async function rejectTicketCompletion(
  ticketId: number,
  submissionId: number,
  rejectReason?: string | null,
  connection?: DbConnection,
  resolvedByLineUserId?: string | null
): Promise<{
  ticket: BoothJobDto;
  submission: TicketCompletionSubmissionDto;
}> {
  const db = client(connection);
  const updateResult = await db.boothJob.updateMany({
    where: {
      id: ticketId,
      status: TICKET_STATUS.DELIVERED,
    },
    data: {
      status: TICKET_STATUS.REJECT,
      rejectReason: rejectReason ?? null,
    },
  });

  if (updateResult.count !== 1) {
    throw new TicketSubmissionAlreadyResolvedError(
      "Ticket reject did not update a waiting ticket.",
    );
  }

  const [ticket, submission] = await Promise.all([
    db.boothJob.findUnique({
      where: {
        id: ticketId,
      },
    }),
    db.ticketCompletionSubmission.update({
      where: {
        id: submissionId,
      },
      data: {
        status: TICKET_STATUS.REJECT,
        rejectedAt: new Date(),
        rejectReason: rejectReason ?? null,
        resolvedByLineUserId: resolvedByLineUserId ?? null,
      },
    }),
  ]);

  return {
    ticket: requireDto(mapBoothJob(ticket), "ticket reject"),
    submission: requireDto(
      mapTicketCompletionSubmission(submission),
      "ticket submission reject"
    ),
  };
}
