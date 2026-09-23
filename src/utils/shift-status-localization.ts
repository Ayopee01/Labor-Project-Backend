// Import Config
import { SHIFT_INACTIVE_REASON } from "../constants/status";
// Import Utils
import { normalizeNotificationLang } from "./notification-localization";
// Import Types
import type { NotificationLang } from "./notification-localization";

/* -------------------------------------- Config -------------------------------------- */

export type ShiftInactiveReasonCode =
  (typeof SHIFT_INACTIVE_REASON)[keyof typeof SHIFT_INACTIVE_REASON];

export type ShiftInactiveReasonParams = {
  // ACCEPT_TIMEOUT_LIMIT_REACHED: จำนวนครั้งที่ปล่อย accept timeout ติดกันได้สูงสุด (worker_accept_timeout_limit)
  accept_timeout_limit?: number;
  // BREAK_RETRY_EXPIRED: หน้าต่างเวลาที่ให้กลับมาต่อ socket เอง หน่วยนาที (worker_break_retry)
  break_retry_minutes?: number;
};

type ShiftInactiveReasonRenderer = (params: ShiftInactiveReasonParams) => string;

// Config ข้อความ reason_text ของแต่ละภาษา ใช้ตอน shift_active เป็น false ใน GET /api/workers/me/status
// หมายเหตุ: MN/CN (เขมร ตาม convention เดิมของโปรเจกต์) แปลโดยไม่ใช่เจ้าของภาษา ต้องให้ native ตรวจก่อนขึ้น production
const SHIFT_INACTIVE_REASON_TEXT: Record<
  NotificationLang,
  Record<ShiftInactiveReasonCode, ShiftInactiveReasonRenderer>
> = {
  TH: {
    OUTSIDE_SHIFT: () => "ขณะนี้ท่านอยู่นอกช่วงเวลาปฏิบัติงานตามกะที่กำหนด",
    ACCEPT_TIMEOUT_LIMIT_REACHED: (params) =>
      `ท่านไม่กดรับงานติดต่อกันครบ ${params.accept_timeout_limit} ครั้ง ระบบจึงปิดกะการทำงานให้ กรุณาติดต่อเจ้าหน้าที่ (Admin)`,
    SCAN_TIMEOUT: () =>
      "ท่านสแกน QR โค้ด/บาร์โค้ดไม่ทันเวลาที่กำหนด กรุณาติดต่อเจ้าหน้าที่ (Admin)",
    ADMIN_CANCELLED_ASSIGNMENT: () =>
      "งานที่ท่านกำลังทำถูกยกเลิก กรุณาติดต่อเจ้าหน้าที่ (Admin)",
    ADMIN_FORCED_STATUS: () =>
      "สถานะของท่านถูกเปลี่ยนแปลง กรุณาติดต่อเจ้าหน้าที่ (Admin)",
    BREAK_RETRY_EXPIRED: (params) =>
      `ท่านไม่ได้กลับเข้าคิวงานภายใน ${params.break_retry_minutes} นาทีหลังหมดเวลาพัก กรุณาติดต่อเจ้าหน้าที่ (Admin)`,
  },
  MN: {
    OUTSIDE_SHIFT: () =>
      "လက်ရှိတွင် သင့်အလုပ်အချိန်ဇယားအပြင်ဘက်တွင် ရှိနေပါသည်။",
    ACCEPT_TIMEOUT_LIMIT_REACHED: (params) =>
      `အလုပ်ကို ဆက်တိုက် ${params.accept_timeout_limit} ကြိမ် လက်မခံခဲ့သဖြင့် အလုပ်အချိန်ပိတ်သွားပါပြီ။ Admin ကို ဆက်သွယ်ပါ။`,
    SCAN_TIMEOUT: () =>
      "QR/barcode ကို အချိန်မီ စကန်မလုပ်ခဲ့ပါ။ Admin ကို ဆက်သွယ်ပါ။",
    ADMIN_CANCELLED_ASSIGNMENT: () =>
      "သင့်အလုပ်ကို ပယ်ဖျက်လိုက်ပါသည်။ Admin ကို ဆက်သွယ်ပါ။",
    ADMIN_FORCED_STATUS: () =>
      "သင့်အခြေအနေကို ပြောင်းလဲလိုက်ပါသည်။ Admin ကို ဆက်သွယ်ပါ။",
    BREAK_RETRY_EXPIRED: (params) =>
      `နားနေချိန်ပြီးနောက် ${params.break_retry_minutes} မိနစ်အတွင်း အလုပ်တန်းစီစဉ်သို့ ပြန်မဝင်ရောက်ခဲ့ပါ။ Admin ကို ဆက်သွယ်ပါ။`,
  },
  CN: {
    OUTSIDE_SHIFT: () => "ឥឡូវនេះអ្នកនៅក្រៅម៉ោងការងាររបស់អ្នក។",
    ACCEPT_TIMEOUT_LIMIT_REACHED: (params) =>
      `អ្នកមិនបានទទួលការងារជាបន្តបន្ទាប់ ${params.accept_timeout_limit} ដង ដូច្នេះវេនការងាររបស់អ្នកត្រូវបានបិទ។ សូមទាក់ទង Admin។`,
    SCAN_TIMEOUT: () =>
      "អ្នកមិនបាន scan QR/barcode ទាន់ពេលទេ។ សូមទាក់ទង Admin។",
    ADMIN_CANCELLED_ASSIGNMENT: () =>
      "ការងាររបស់អ្នកត្រូវបានលុបចោល។ សូមទាក់ទង Admin។",
    ADMIN_FORCED_STATUS: () =>
      "ស្ថានភាពរបស់អ្នកត្រូវបានផ្លាស់ប្តូរ។ សូមទាក់ទង Admin។",
    BREAK_RETRY_EXPIRED: (params) =>
      `អ្នកមិនបានត្រឡប់ទៅជួរការងារវិញក្នុងរយៈពេល ${params.break_retry_minutes} នាទីបន្ទាប់ពីការសម្រាកបានផុតកំណត់។ សូមទាក់ទង Admin។`,
  },
  EN: {
    OUTSIDE_SHIFT: () => "You are currently outside your scheduled work shift.",
    ACCEPT_TIMEOUT_LIMIT_REACHED: (params) =>
      `You did not accept jobs for ${params.accept_timeout_limit} times in a row, so your shift was closed. Please contact Admin.`,
    SCAN_TIMEOUT: () =>
      "You did not scan the QR code/barcode in time. Please contact Admin.",
    ADMIN_CANCELLED_ASSIGNMENT: () =>
      "Your assignment was cancelled. Please contact Admin.",
    ADMIN_FORCED_STATUS: () => "Your status was changed. Please contact Admin.",
    BREAK_RETRY_EXPIRED: (params) =>
      `You did not rejoin the queue within ${params.break_retry_minutes} minutes after your break ended. Please contact Admin.`,
  },
};

/* -------------------------------------- Functions -------------------------------------- */

// Function หาข้อความ reason_text ตามภาษาของ worker (worker.lang) สำหรับ shift_active = false
export function resolveShiftInactiveReasonText(
  code: ShiftInactiveReasonCode,
  lang?: string | null,
  params: ShiftInactiveReasonParams = {},
): string {
  return SHIFT_INACTIVE_REASON_TEXT[normalizeNotificationLang(lang)][code](params);
}
