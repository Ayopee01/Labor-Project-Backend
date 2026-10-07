/* -------------------------------------- Gate Options -------------------------------------- */

// Type ตัวเลือกตลาดสำหรับหน้า Gate UI
export interface GateMarketOption {
  MarketCode: string;
  MarketName: string;
}

// Type ตัวเลือกแผงค้าสำหรับหน้า Gate UI
export interface GateBoothOption {
  BoothCode: string;
  BoothName: string;
}

// Type ตัวเลือกแพ็กเกจของสินค้า
export interface GatePackageOption {
  PackageCode: string;
  PackageName: string;
  PackageWeight: number;
}

// Type ตัวเลือกสินค้าพร้อมแพ็กเกจ
export interface GateProductOption {
  ProductCode: string;
  ProductName: string;
  Packages: GatePackageOption[];
}

// Type response สำหรับ Dropdown/Select ของ Gate UI
export interface GateOptionsResponse {
  Markets: GateMarketOption[];
  Booths: GateBoothOption[];
  Products: GateProductOption[];
}

/* -------------------------------------- Gate Create Input -------------------------------------- */

// Type ข้อมูลสินค้าก่อนบันทึกจาก Gate
export interface GateProductCreateInput {
  productCode: string;
  productFullCode: string;
  productName: string;
  packageCode: string;
  packageName: string;
  quantity: number;
  requiredWorkerCount: number;
  packageWeightSnapshot: string;
  rateIdSnapshot: number;
  sourceRateIdSnapshot: number;
  rateMarketCode: string;
  rateSource:
  | "MARKET_RATE"
  | "CENTRAL_RATE";

  weightRangeName: string;
  weightMinSnapshot: string;
  weightMaxSnapshot: string;
  stallRateSnapshot: string;
  laborRateSnapshot: string;
  rateSnapshotAt: Date;
}

// Type ข้อมูลแผงก่อนบันทึกจาก Gate
export interface GateBoothCreateInput {
  boothCode: string;
  boothName: string;

  vendor_line_id?: string;
  reject_reason?: string;

  products: GateProductCreateInput[];
}

// Type ข้อมูล Business Ticket (market job) ก่อนบันทึกจาก Gate
export interface GateMarketCreateInput {
  ticketNo: string;
  ticket_created_at: Date;
  booth_count: number;
  gate_transaction_ref: string;
  workers_required: number;
  marketCode: string;
  marketName: string;
  dropoff_point: string;
  booths: GateBoothCreateInput[];
}

// Type input สำหรับสร้าง Business Ticket หลายตลาดใต้ TicketJob เดียว
export interface BoothJobJobCreateInput {
  ticketNumber: string;

  license_plate: string;
  license_plate_province: string;
  vehicle_type: string;
  vehicle_type_code: string;
  dispatch_now: boolean;
  gate_no: string;
  gate_client_id: number | null;
  markets: GateMarketCreateInput[];
}

/* -------------------------------------- Gate Request -------------------------------------- */

// Type สินค้าที่ Gate ส่งมา
export interface BoothJobJobProductBody {
  ProductCode: string;
  PackageCode: string;
  Quantity: number;
}

// Type แผงและสินค้าที่ Gate ส่งมา
export interface BoothJobJobBoothBody {
  BoothCode: string;
  Products: BoothJobJobProductBody[];
}

// Type ตั๋ว 1 ใบ (1 ตลาด) ที่ Gate ส่งมา
export interface BoothJobJobMarketBody {
  TicketNo: string;
  TicketCreatedAt: string;
  MarketCode: string;
  DropoffPoint: string;
  Booths: BoothJobJobBoothBody[];
}

// Type request หลักจาก Gate (หลายตลาดในครั้งเดียว)
export interface BoothJobJobBody {
  TicketNumber: string;
  GateNo: string;
  LicensePlate: string;
  LicensePlateProvince: string;
  VehicleTypeCode: string;
  VehicleTypeName: string;
  Markets: BoothJobJobMarketBody[];
  Dispatch: boolean;
  IdempotencyKey?: string;
}

// Type request แก้ไขตั๋ว 1 ใบจาก Gate (TicketNo มาจาก path)
export interface GateTicketUpdateBody {
  GateNo: string;
  Version?: string;
  MarketCode: string;
  DropoffPoint: string;
  Booths: BoothJobJobBoothBody[];
}

/* -------------------------------------- Gate Response -------------------------------------- */

// Type สถานะผลของ request จาก Gate
export type BoothJobJobResult =
  | "CREATED"
  | "REPLAYED"
  | "UPDATED"
  | "NO_CHANGE";

// Type สถานะงานที่คืนให้ Gate
export type BoothJobJobResponseStatus =
  | "unload_now"
  | "waiting_unload";

// Type ข้อมูลรถที่คืนให้ Gate
interface BoothJobJobResponseVehicle {
  LicensePlate: string;
  LicensePlateProvince: string | null;

  VehicleTypeCode: string | null;
  VehicleTypeName: string | null;

  Status: BoothJobJobResponseStatus;
}

// Type Product response ของ Gate ยังไม่รวมข้อมูลเงินจริง
interface BoothJobJobResponseProduct {
  ProductCode: string;
  ProductFullCode: string | null;
  ProductName: string;
  PackageCode: string;
  PackageName: string;
  Quantity: number;
  WorkerCount: number;
}

// Type ข้อมูล Booth ที่คืนให้ Gate
export interface BoothJobJobResponseBooth {
  BoothCode: string;
  BoothName: string | null;

  Products: BoothJobJobResponseProduct[];
}

// Type ข้อมูลตั๋ว 1 ใบ (1 ตลาด) ที่คืนให้ Gate
export interface BoothJobJobResponseMarket {
  TicketNo: string;
  TicketCreatedAt: string;
  MarketCode: string;
  MarketName: string;
  DropoffPoint: string | null;
  BoothCount: number;
  // MAX ของจำนวน Worker ทุกสินค้าในตั๋วใบนี้
  WorkerCount: number;
  Booths: BoothJobJobResponseBooth[];
}

// Type response หลักของ Gate create/update
export interface BoothJobJobResponse {
  Result: BoothJobJobResult;
  TicketNumber: string;
  GateNo: string;
  Vehicle: BoothJobJobResponseVehicle;
  Markets: BoothJobJobResponseMarket[];
  // ผลรวม WorkerCount ของทุกตั๋วที่ยัง active บนรถ
  WorkerCount: number;

  Qr: {
    DriverQrToken: string;
    DriverQrUrl: string;
  };
}

// Type สรุปการเปลี่ยนแปลงของแผงตอน Gate แก้ไขตั๋ว
export interface GateTicketChangeSummary {
  MarketChanged: boolean;
  DropoffPointChanged: boolean;
  Added: string[];
  Removed: string[];
  // แผงเดิมที่แก้ชื่อ/สินค้าในแถวเดิม (BoothJob id ไม่เปลี่ยน)
  Updated: string[];
  Unchanged: string[];
  PreviousWorkerCount: number;
  WorkerCount: number;
}

// Type response ของ Gate แก้ไขตั๋ว
export interface GateTicketUpdateResponse extends BoothJobJobResponse {
  Changes: GateTicketChangeSummary;
}

// Type สภาพตั๋ว 1 ใบ ณ เวลาหนึ่ง (เก็บเป็นประวัติก่อน/หลัง Gate แก้ไข)
export interface GateTicketRevisionSnapshot {
  MarketJobId: string;
  TicketNo: string;
  MarketCode: string;
  MarketName: string;
  DropoffPoint: string | null;
  WorkerCount: number;
  Booths: Array<{
    BoothJobId: string;
    BoothCode: string;
    BoothName: string | null;
    Status: string;
    Products: GateTicketRevisionProduct[];
  }>;
}

// Type สินค้า 1 รายการใน snapshot ของตั๋ว
export interface GateTicketRevisionProduct {
  TicketProductId: string;
  ProductCode: string;
  PackageCode: string;
  Quantity: number;
  WorkerCount: number;
}

// Config ประเภทรายละเอียดการแก้ตั๋วของ Gate (stable enum ให้ Frontend แปลข้อความเอง)
export const GATE_TICKET_CHANGE_DETAIL_TYPE = {
  MARKET_CHANGED: "MARKET_CHANGED",
  DROPOFF_POINT_CHANGED: "DROPOFF_POINT_CHANGED",
  WORKER_COUNT_CHANGED: "WORKER_COUNT_CHANGED",
  BOOTH_ADDED: "BOOTH_ADDED",
  BOOTH_REMOVED: "BOOTH_REMOVED",
  BOOTH_UPDATED: "BOOTH_UPDATED",
  PRODUCT_ADDED: "PRODUCT_ADDED",
  PRODUCT_REMOVED: "PRODUCT_REMOVED",
  PRODUCT_UPDATED: "PRODUCT_UPDATED",
} as const;

// Type ประเภทรายละเอียดการแก้ตั๋วของ Gate
export type GateTicketChangeDetailType =
  (typeof GATE_TICKET_CHANGE_DETAIL_TYPE)[keyof typeof GATE_TICKET_CHANGE_DETAIL_TYPE];

// Type ค่าก่อน/หลังของรายละเอียดการแก้ตั๋ว (มีเฉพาะ field ที่เปลี่ยน)
export type GateTicketChangeValue = string | number | null | Record<string, unknown>;

// Type รายละเอียดการแก้ตั๋ว 1 รายการ (เก็บใน GateRequestLog.change_details)
export interface GateTicketChangeDetail {
  Type: GateTicketChangeDetailType;
  BoothJobId?: string;
  BoothCode?: string;
  TicketProductId?: string;
  ProductCode?: string;
  PackageCode?: string;
  Fields?: string[];
  Before?: GateTicketChangeValue;
  After?: GateTicketChangeValue;
}

// Type เหตุผลที่แผงหรือตั๋วแก้ไขไม่ได้
export type GateTicketLockReason =
  | "TICKET_ALREADY_SUBMITTED"
  | "BOOTH_ALREADY_CLOSED";

// Type แผงใน response GET ตั๋วของ Gate
interface GateTicketDetailBooth extends BoothJobJobResponseBooth {
  Status: string;
  Editable: boolean;
  LockReason: GateTicketLockReason | null;
}

// Type response GET ตั๋ว 1 ใบสำหรับให้ Gate UI แสดงและแก้ไข
export interface GateTicketDetailResponse {
  TicketNumber: string;
  GateNo: string | null;
  // ส่งกลับมาใน PUT เพื่อกันเขียนทับข้อมูลที่เปลี่ยนไปแล้ว
  Version: string;
  Vehicle: Omit<BoothJobJobResponseVehicle, "Status"> & { Status: string };
  Market: Omit<BoothJobJobResponseMarket, "Booths"> & {
    Status: string;
    // เปลี่ยนตลาดได้เฉพาะเมื่อทุกแผงยังไม่ส่งยอด
    MarketEditable: boolean;
    Booths: GateTicketDetailBooth[];
  };
  WorkerCount: number;

  Qr: {
    DriverQrToken: string;
    DriverQrUrl: string;
  };
}

/* -------------------------------------- Gate Ticket Records -------------------------------------- */

// Type สินค้าของแผงที่บันทึกไว้ (ใช้เทียบตอน Gate แก้ไขตั๋ว)
export interface GateTicketBoothProductRecord {
  id: number;
  product_code: string;
  product_full_code: string | null;
  product_name: string;
  package_code: string;
  package_name: string;
  quantity: number;
  required_worker_count: number;
}

// Type แผงที่ยังไม่ถูกยกเลิกของตั๋ว พร้อมสินค้า
export interface GateTicketBoothRecord {
  id: number;
  booth_code: string;
  booth_name: string | null;
  status: string;
  products: GateTicketBoothProductRecord[];
}

/* -------------------------------------- Gate Replay -------------------------------------- */

// Type ข้อมูล Gate request สำหรับ replay
export interface GateRequestReplayRecord {
  gate_transaction_ref: string;
  payload_snapshot: unknown;
  response_snapshot:
  BoothJobJobResponse | null;
}
