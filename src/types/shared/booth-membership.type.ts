// Type ส่วน DTO ข้อมูลสมาชิกของแผงที่ใช้หาคนได้เงิน (roster, snapshot, คนที่ถูกถอด และยอดรายคน)
export interface BoothMembershipRecord {
  id: number;
  booth_code: string;
  booth_name: string | null;
  status: string;
  market_job_id: number;
  ticket_no: string;
  market_name: string;
  roster: Array<{ ticket_worker_id: number; worker_id: number; status: string }>;
  // snapshot ตอน Vendor ยืนยัน (มีเฉพาะแผง COMPLETED)
  booth_snapshot_ticket_worker_ids: number[];
  excluded_ticket_worker_ids: number[];
  // worker ที่ Admin เลือกให้เข้าแผง REJECT (master worker id)
  included_worker_ids: number[];
  // รอบส่งยอดล่าสุดพร้อม snapshot รายชื่อตอนส่ง
  latest_submission: {
    created_at: string;
    snapshot_ticket_worker_ids: number[];
  } | null;
  products: Array<{
    labor_fee_raw: string | null;
    // null = ยังไม่ปิดยอดทั้งใบ
    payments: Array<{ ticket_worker_id: number; final_amount: string }> | null;
  }>;
}
