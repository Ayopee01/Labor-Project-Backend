// Import Mappers
import { mapTicketJob, mapTicketJobAssignment } from "./shared/mappers";
import { client, requireDto } from "./shared/repository-utils";
// Import Types
import type { DbConnection } from "../types/shared/common.type";
import type { WorkerAssignmentHistoryItemDto, WorkerEarningsSummaryResponse } from "../types/worker.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function ดึงประวัติงานที่ Worker ถูกมอบหมายในช่วงวันที่กำหนด จาก DB
export async function listWorkerAssignmentHistoryByDate(
  workerId: number,
  startAt: Date,
  endAt: Date,
  connection?: DbConnection,
): Promise<WorkerAssignmentHistoryItemDto[]> {
  const db = client(connection);
  const assignments = await db.ticketJobAssignment.findMany({
    where: {
      workerId,
      createdAt: {
        gte: startAt,
        lt: endAt,
      },
    },
    orderBy: {
      createdAt: "desc",
    },
    include: {
      ticketJob: {
        include: {
          marketJobs: {
            orderBy: {
              id: "asc",
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
                  },
                  completionSubmissions: {
                    orderBy: {
                      id: "desc",
                    },
                  },
                  rating: true,
                },
              },
            },
          },
        },
      },
    },
  });

  return assignments.map((assignment) => ({
    assignment: requireDto(mapTicketJobAssignment(assignment), "assignment"),
    vehicle_job: requireDto(
      mapTicketJob(assignment.ticketJob),
      "vehicle job",
    ),
    markets: assignment.ticketJob.marketJobs.map((market) => ({
      ticket_no: market.ticketNo,
      marketCode: market.marketCode,
      marketName: market.marketName,
      booths: market.tickets.map((ticket) => {
        const latestSubmission = ticket.completionSubmissions[0];

        return {
          boothCode: ticket.boothCode,
          boothName: ticket.boothName,
          status: ticket.status,
          confirmation_status: ticket.status,
          completed_at: ticket.completedAt?.toISOString() ?? null,
          confirmed_at: latestSubmission?.confirmedAt?.toISOString() ?? null,
          products: ticket.products.map((product) => ({
            productCode: product.productCode,
            productName: product.productName,
            packageCode: product.packageCode,
            packageName: product.packageName,
            confirmed_quantity: product.confirmedQuantity?.toFixed(2) ?? null,
          })),
          rating: ticket.rating?.score ?? null,
        };
      }),
    })),
  }));
}

// Function ดึงสรุปรายได้ของ Worker ต่อ Business Ticket (ไม่ใช่ต่อ Booth เพราะ TicketWorker
// เป็น Roster ระดับ Business Ticket แล้ว final_earning_amount จึงรวมทุก Booth ของ Ticket นั้น)
export async function listWorkerEarningsSummaryRows(
  workerId: number,
  startAt: Date,
  endAt: Date,
  connection?: DbConnection,
): Promise<WorkerEarningsSummaryResponse["details"]> {
  const db = client(connection);
  const rows = await db.ticketWorker.findMany({
    where: {
      workerId,
      finalEarningAmount: {
        not: null,
      },
      marketJob: {
        completedAt: {
          gte: startAt,
          lt: endAt,
        },
        financializedAt: {
          not: null,
        },
      },
    },
    orderBy: [
      {
        marketJob: {
          completedAt: "desc",
        },
      },
      {
        id: "asc",
      },
    ],
    include: {
      marketJob: {
        include: {
          ticketJob: true,
        },
      },
    },
  });

  return rows.map((row) => ({
    completed_at: row.marketJob.completedAt?.toISOString() ?? "",
    ticket_number: row.marketJob.ticketJob.ticketNumber,
    ticket_no: row.marketJob.ticketNo,
    license_plate: row.marketJob.ticketJob.licensePlate,
    license_plate_province: row.marketJob.ticketJob.licensePlateProvince,
    booth_count: row.marketJob.boothCount,
    marketCode: row.marketJob.marketCode,
    marketName: row.marketJob.marketName,
    earnings: row.finalEarningAmount?.toFixed(2) ?? "0.00",
  }));
}
