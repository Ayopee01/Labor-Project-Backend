// Import Types
import type { TicketJobDto } from "../worker.type";

/* -------------------------------------- Types -------------------------------------- */

// Type ผู้สั่งเปิด/ปิด dispatch ของงานรถ
export type VehicleDispatchActor =
  | { type: "admin"; account_id: number }
  | { type: "driver"; driver_session_id: number };

// Type input ของ service กลางที่เปิด/ปิด dispatch ของงานรถ
export interface ChangeTicketJobDispatchInput {
  ticket_job: TicketJobDto;
  dispatch: boolean;
  actor: VehicleDispatchActor;
  reason_code: string;
  reason_text: string | null;
}

// Type ผลการเปิด/ปิด dispatch (changed=false คือสถานะตรงกับที่ขออยู่แล้ว ไม่มีอะไรเปลี่ยน)
export interface ChangeTicketJobDispatchResult {
  changed: boolean;
  ticket_job: TicketJobDto;
  worker_to_queue: Array<string | null>;
  worker_to_openapp: Array<string | null>;
}
