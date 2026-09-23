/* -------------------------------------- Types -------------------------------------- */

// Type session ของ driver ที่สร้างจาก QR/token ของงานรถ
export interface DriverSessionDto {
  id: number;
  vehicle_job_id: number;
  device_id: string | null;
  session_token: string;
  expires_at: string;
  revoked_at: string | null;
  read_only_until: string | null;
  created_at: string;
  updated_at: string;
}

// Type session ที่ผ่านการตรวจสอบแล้วว่ายังใช้งานได้ (active หรืออยู่ใน terminal grace period) — แนบ
// is_read_only เพื่อให้ route ที่ mutate (เช่น ready) ปฏิเสธได้ทันทีโดยไม่ต้อง query ซ้ำ
export interface DriverSessionContext extends DriverSessionDto {
  is_read_only: boolean;
}

// Type slot ของ active driver session หนึ่งเครื่อง — ใช้ตัดสิน device limit/rotate เท่านั้น ไม่มี session token ดิบ
export interface ActiveDriverSessionSlotDto {
  id: number;
  device_id: string | null;
}

// Type ข้อมูลงานรถแบบย่อที่ driver เห็น
export interface DriverTicketJobResponse {
  ticket_number: string;
  license_plate: string;
  license_plate_province: string | null;
  vehicle_type: string | null;
  workers_required: number;
  status: string;
  created_at: string;
  updated_at: string;
}

// Type รายการสินค้าใน ticket สำหรับ driver
interface DriverJobProductResponse {
  productCode: string;
  productName: string;
  packageCode: string;
  packageName: string;
  quantity: string;
}

// Type booth ในรายละเอียดงานของ driver
interface DriverJobBoothResponse {
  boothCode: string;
  boothName: string | null;
  status: string;
  confirmation_status: string;
  products: DriverJobProductResponse[];
}

// Type Business Ticket (market job) ที่รวม Booth สำหรับหน้ารายละเอียด driver
interface DriverJobMarketResponse {
  ticket_no: string;
  ticket_created_at: string;
  marketCode: string;
  marketName: string;
  dropoff_point: string | null;
  status: string;
  booth_count: number;
  booths: DriverJobBoothResponse[];
}

// Type ข้อมูลงานรถแบบเต็มสำหรับหน้ารายละเอียด driver — ต่างจาก DriverTicketJobResponse (ใช้ตอนสร้าง
// session เท่านั้น) ตรงที่มีเวลาที่หน้า Driver Web ต้องใช้แสดงผลครบ
interface DriverJobVehicleResponse {
  ticket_number: string;
  license_plate: string;
  license_plate_province: string | null;
  vehicle_type: string | null;
  workers_required: number;
  status: string;
  work_started_at: string | null;
  completed_at: string | null;
  // เวลาปิดงานจาก server: งานสำเร็จใช้ completed_at, งานยกเลิกใช้เวลาที่สถานะเปลี่ยนเป็น CANCELLED (updated_at)
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

// Type response หลักของหน้า Driver Web (GET /jobs/current, POST .../ready, และ SSE snapshot/update ทุกชนิด)
export interface DriverJobSnapshotResponse {
  operation_status: string;
  vehicle_job: DriverJobVehicleResponse;
  markets: DriverJobMarketResponse[];
}

// Type response หลังสร้าง driver session สำเร็จ
export interface DriverSessionResponse {
  driver_session_token: string;
  expires_in: number;
  expires_at: string;
  vehicle_job: DriverTicketJobResponse;
  active_device_count: number;
  active_device_limit: number;
}
