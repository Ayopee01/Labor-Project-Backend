// Import Types
import type { AccessTokenPayload, SessionDto } from "../auth.type";
import type { PublicGateClient } from "../shared/gate-client.type";
import type { DriverSessionDto } from "../driver.type";

/* -------------------------------------- Type Declarations -------------------------------------- */

declare global {
  namespace Express {
    // Type เพิ่ม field ที่ middleware แนบเข้ามาบน Express Request
    interface Request {
      auth?: AccessTokenPayload;
      session?: SessionDto;
      driverSession?: DriverSessionDto;
      gateClient?: PublicGateClient;
      rawBody?: string;
      requestId?: string;
    }
  }
}

export {};
