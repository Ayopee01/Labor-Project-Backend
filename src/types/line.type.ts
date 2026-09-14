/* -------------------------------------- Types -------------------------------------- */

// Type event จาก LINE webhook ที่ระบบใช้งานจริง
export type LineWebhookEvent = {
  type?: string;
  source?: {
    userId?: string;
    user_id?: string;
  };
  postback?: {
    data?: string;
  };
  message?: {
    text?: string;
  };
};

// Type ข้อความ text ที่ส่งผ่าน LINE Messaging API
type LineTextMessage = {
  type: "text";
  text: string;
};

// Type action แบบ postback ที่ vendor กดใน LINE
type LinePostbackAction = {
  type: "postback";
  label: string;
  data: string;
  displayText?: string;
};

// Type template message แบบปุ่มกดของ LINE
type LineTemplateMessage = {
  type: "template";
  altText: string;
  template: {
    type: "buttons";
    title?: string;
    text: string;
    actions: LinePostbackAction[];
  };
};

// Type flex message สำหรับ UI แจ้งลงสินค้า ตรวจยอด และให้คะแนน
type LineFlexMessage = {
  type: "flex";
  altText: string;
  contents: Record<string, unknown>;
};

// Type component ย่อยของ LINE Flex
export type LineFlexComponent = Record<string, unknown>;

// Type union ของข้อความ LINE ที่ queue ส่งออกได้
export type LineMessage = LineTextMessage | LineTemplateMessage | LineFlexMessage;

// Type payload ของ queue สำหรับส่ง LINE message หนึ่งชุด
export type LineMessageJobData = {
  log_id: number;
  to: string;
  messages: LineMessage[];
};

// Type action ที่ token ของ vendor รองรับ
export type VendorTicketAction =
  | "vendor_confirm_completion"
  | "vendor_reject_completion"
  | "vendor_rate_ticket";

// Type payload ใน token ที่ผูกกับ action ของ vendor ต่อ ticket
export interface VendorTicketActionTokenPayload {
  token_type: "vendor_ticket_action";
  id: number;
  action: VendorTicketAction;
  ticket_id: number;
  submission_id: number;
  boothCode: string;
  iat: number;
  exp: number;
}

// Config ช่วงคะแนนความพึงพอใจที่ Vendor ให้ได้
export const MIN_RATING_SCORE = 1;
export const MAX_RATING_SCORE = 5;

// Type คะแนนความพึงพอใจที่ vendor ให้กับ ticket
export interface TicketRatingDto {
  id: number;
  ticket_id: number;
  submission_id: number;
  line_user_id: string;
  target_type: string | null;
  score: number;
  rated_at: string;
  created_at: string;
  updated_at: string;
}

// Type token action ที่บันทึกใน DB เพื่อกันกดซ้ำและตรวจหมดอายุ
export interface LineActionTokenDto {
  id: number;
  token: string;
  action: VendorTicketAction;
  ticket_id: number;
  submission_id: number;
  boothCode: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
  updated_at: string;
}

// Type action หลัง vendor ตรวจยอดส่งงาน
export type VendorTicketCompletionAction = "confirm" | "reject";

// Type รายการ Submission สำหรับหน้า LINE dev tester (ใช้เป็นทางสำรองกรณีเส้น LINE ติดลิมิต)
export interface LineDevSubmissionItem {
  submission_id: number;
  ticket_id: number;
  submission_status: string;
  ticket_status: string;
  actionable: boolean;
  ticket_number: string;
  ticket_no: string;
  license_plate: string;
  market_code: string;
  market_name: string;
  boothCode: string;
  boothName: string | null;
  submitted_by_code: string | null;
  submitted_by_name: string | null;
  submitted_by_role: string;
  submitted_at: string;
  confirmed_at: string | null;
  rejected_at: string | null;
  reject_reason: string | null;
  products: Array<{
    productCode: string;
    productName: string;
    packageCode: string;
    packageName: string;
    expected_quantity: string;
    submitted_quantity: string | null;
  }>;
}

export interface LineDevCompletionResult {
  message: string;
  submission_id: number;
  ticket_id: number;
  boothCode: string;
  ticket_status: string;
  submission_status: string;
  action: VendorTicketCompletionAction;
  vehicle_job_status: string | null;
}

// Type ผลลัพธ์กลางของ flow confirm/reject สำหรับส่งต่อ realtime และ LINE
export interface VendorTicketCompletionFlowResult {
  ticket: import("./worker.type").BoothJobDto;
  submission: import("./worker.type").TicketCompletionSubmissionDto;
  products: import("./worker.type").TicketProductDto[];
  detail: import("./worker.type").TicketJobDetailResponse | null;
  completedTicketJob: import("./worker.type").CompletedTicketJobResult | null;
  completedWorkerCodes: Array<string | null>;
  nextTicket: import("./worker.type").CurrentTicketProgressDto | null;
  receiverAccountIds: number[];
  assignmentStatus: string;
  isConfirmed: boolean;
  title: string;
  message: string;
}
