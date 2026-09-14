/* -------------------------------------- Types -------------------------------------- */

// Type session ของ driver ที่สร้างจาก QR/token ของงานรถ
export interface DriverSessionDto {
  id: number;
  vehicle_job_id: number;
  session_token: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
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
interface DriverTicketProductResponse {
  productCode: string;
  productName: string;
  packageCode: string;
  packageName: string;
  quantity: string;
}

// Type ticket/booth ในรายละเอียดงานของ driver
interface DriverTicketResponse {
  boothCode: string;
  boothName: string | null;
  status: string;
  confirmation_status: string;
  products: DriverTicketProductResponse[];
}

// Type Business Ticket (market job) ที่รวม Booth สำหรับหน้ารายละเอียด driver
interface DriverMarketJobResponse {
  ticket_no: string;
  boothCount: number;
  marketCode: string;
  marketName: string;
  status: string;
  booths: DriverTicketResponse[];
}

// Type response รายละเอียดงานรถทั้งหมดสำหรับ driver
export interface DriverTicketJobDetailResponse {
  vehicle_job: DriverTicketJobResponse;
  markets: DriverMarketJobResponse[];
}

// Type response หลัง driver scan ว่าพร้อมลงสินค้า
export interface DriverJobReadyResponse {
  ticket_number: string;
  license_plate: string;
  license_plate_province: string | null;
  status: string;
}

// Type response หลังสร้าง driver session สำเร็จ
export interface DriverSessionResponse {
  driver_session_token: string;
  expires_in: number;
  expires_at: string;
  vehicle_job: DriverTicketJobResponse;
}
