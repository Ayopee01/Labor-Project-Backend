/* รูปแบบ error กลางของระบบ ใช้ร่วมกันใน routes, services และ middlewares */
export default class ApiError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);

    this.name = "ApiError"; // กำหนดชื่อของ error เป็น "ApiError"
    this.statusCode = statusCode; // กำหนดรหัสสถานะ HTTP ของ error
    this.code = code; // กำหนดรหัสของ error เพื่อระบุประเภทของ error
    this.details = details; // กำหนดรายละเอียดเพิ่มเติมของ error (ถ้ามี)

    Error.captureStackTrace?.(this, ApiError);
  }
}
