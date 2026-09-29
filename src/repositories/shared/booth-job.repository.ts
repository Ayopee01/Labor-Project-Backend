// Import Config
import { MASTER_MARKET_ACTIVE_STATUS, MASTER_OWNER_STALL_ACTIVE_STATUS, SCANNED_ASSIGNMENT_STATUSES, TERMINAL_TICKET_STATUSES, TICKET_STATUS, TICKET_SUBMITTER_ROLE, TICKET_WORKER_STATUS } from "../../constants/status";
// Import Repositories
import { client, requireDto } from "./repository-utils";
// Import Mappers
import { mapBoothJob, mapTicketCompletionSubmission, mapTicketProduct } from "./mappers";
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

// Function ตรวจว่างานรถมีแผงที่ส่งยอดแล้ว (DELIVERED/REJECT) หรือไม่
export async function hasSubmittedActiveTicketsForTicketJob(
  ticketJobId: number,
  connection?: DbConnection
): Promise<boolean> {
  const db = client(connection);
  const count = await db.boothJob.count({
    where: {
      ticketJobId,
      status: {
        in: [TICKET_STATUS.DELIVERED, TICKET_STATUS.REJECT],
      },
    },
  });

  return count > 0;
}

// Function ดึง TicketWorker id ที่ถูกถอดออกจากแผงนี้
export async function listExcludedTicketWorkerIdsForBooth(
  boothJobId: number,
  connection?: DbConnection
): Promise<number[]> {
  const db = client(connection);
  const exclusions = await db.boothJobWorkerExclusion.findMany({
    where: {
      boothJobId,
    },
    select: {
      ticketWorkerId: true,
    },
  });

  return exclusions.map((exclusion) => exclusion.ticketWorkerId);
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

// Function นับ worker ที่ยังทำแผงนี้ได้ (roster WORKING และไม่ถูกถอดออกจากแผงนี้)
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

// Function ถอด worker ออกจากแผงเดียว (ไม่แตะสถานะ roster ของ Business Ticket)
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

// Function ค้นหาแผง (BoothJob) ตาม ID สำหรับส่งยอด
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

// Function หา LINE target (เจ้าของและสมาชิก) ของแผงจาก marketCode + boothCode
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

// Function ดึงแผงที่ยังไม่จบของ Business Ticket (เรียกก่อนยกเลิกเพื่อรู้ว่าต้องแจ้ง LINE แผงไหน)
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

// Function ดึงแผงที่ยังไม่จบของงานรถพร้อม ticket_no/marketName (เรียกก่อนยกเลิกทั้งรถ)
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

// Function ยกเลิกแผง (ไม่แตะ roster เพราะ worker ยังทำแผงอื่นในใบเดียวกันได้)
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

// Function บันทึก snapshot กลุ่ม worker ของ submission (ชุดเดียวกับที่ใช้นับ workerCountSnapshot)
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

// Function หา submission ล่าสุดที่ Worker ส่งเอง พร้อมกลุ่ม worker ใน snapshot (ใช้ตอน Admin ส่งแทน)
export async function findLatestWorkerSubmissionSnapshot(
  ticketId: number,
  connection?: DbConnection
): Promise<{ submissionId: number; ticketWorkerIds: number[] } | null> {
  const db = client(connection);
  const submission = await db.ticketCompletionSubmission.findFirst({
    where: {
      ticketId,
      submittedByRole: TICKET_SUBMITTER_ROLE.WORKER,
    },
    orderBy: {
      id: "desc",
    },
    select: {
      id: true,
      workerSnapshots: {
        select: {
          ticketWorkerId: true,
        },
        orderBy: {
          id: "asc",
        },
      },
    },
  });

  if (!submission) {
    return null;
  }

  return {
    submissionId: submission.id,
    ticketWorkerIds: submission.workerSnapshots.map((snapshot) => snapshot.ticketWorkerId),
  };
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

// Function ตรวจว่าแผงเคยถูก Vendor reject มาก่อน (ใช้เลือก timeout รอบส่งใหม่)
export async function hasRejectedTicketCompletionSubmission(
  ticketId: number,
  connection?: DbConnection
): Promise<boolean> {
  const db = client(connection);
  const count = await db.ticketCompletionSubmission.count({
    where: {
      ticketId,
      status: TICKET_STATUS.REJECT,
    },
  });

  return count > 0;
}

// Function หาแผงที่ค้าง DELIVERED พร้อม submission ล่าสุด สำหรับกู้คืนตอน server เริ่ม
export async function listDeliveredTicketsWithLatestSubmission(
  connection?: DbConnection
): Promise<Array<{
  ticket: BoothJobDto;
  submission: TicketCompletionSubmissionDto;
  is_resubmission: boolean;
}>> {
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
      _count: {
        select: {
          completionSubmissions: {
            where: {
              status: TICKET_STATUS.REJECT,
            },
          },
        },
      },
    },
  });

  const results: Array<{
    ticket: BoothJobDto;
    submission: TicketCompletionSubmissionDto;
    is_resubmission: boolean;
  }> = [];

  for (const ticket of tickets) {
    const mappedTicket = mapBoothJob(ticket);
    const mappedSubmission = mapTicketCompletionSubmission(ticket.completionSubmissions[0] ?? null);

    if (mappedTicket && mappedSubmission) {
      results.push({
        ticket: mappedTicket,
        submission: mappedSubmission,
        is_resubmission: ticket._count.completionSubmissions > 0,
      });
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

  // roster ไม่ถูกแตะที่นี่ ปิดเป็น COMPLETED ตอนปิดยอดทั้ง Business Ticket

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
    // ตัวหารเงินของแผง = กลุ่ม worker ใน snapshot ของรอบที่ถูกยืนยัน (ไม่ใช่ roster ตอนนี้)
    const submissionWorkers = await db.ticketWorker.findMany({
      where: {
        marketJobId: ticket.marketJobId,
        workerSnapshots: {
          some: {
            submissionId,
          },
        },
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
    // submission เก่าที่ไม่มี snapshot ใช้ roster ที่ยัง WORKING แทน
    const workingWorkers =
      submissionWorkers.length > 0
        ? submissionWorkers
        : await db.ticketWorker.findMany({
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
