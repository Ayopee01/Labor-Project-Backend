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
