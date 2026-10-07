// Import Library
import type { Prisma } from "@prisma/client";

// Type ผลการปิดยอดเงินของ Business Ticket
export type TicketFinancializationResult = {
  marketJobId: number;
  productCount: number;
  workerCount: number;
  finalStallAmount: Prisma.Decimal;
  finalizedAt: Date;
  alreadyFinalized: boolean;
};

// Type ผลการคิดเงิน Worker ของแผงใหม่หลังปิดยอดแล้ว (ยอดเป็น string เพื่อบันทึกลง audit log)
export type BoothPayoutRecalculation = {
  marketJobId: number;
  boothJobId: number;
  ticketWorkerIdsBefore: number[];
  ticketWorkerIdsAfter: number[];
  products: Array<{
    ticketProductId: number;
    workerCountBefore: number;
    workerCountAfter: number;
    workerPayoutTotalBefore: string;
    workerPayoutTotalAfter: string;
    fundAmountBefore: string;
    fundAmountAfter: string;
  }>;
  // key = ticket_worker_id
  workerAmountsBefore: Record<string, string>;
  workerAmountsAfter: Record<string, string>;
};
