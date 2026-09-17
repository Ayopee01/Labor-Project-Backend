import { TICKET_STATUS } from "../constants/status";

export type NotificationLang = "TH" | "MN" | "CN" | "EN";

export type LocalizedNotification = {
  key: string;
  lang: NotificationLang;
  title: string;
  message: string;
};

type NotificationTemplate = {
  title: string;
  message: string;
};

type TemplateRenderer = (params: Record<string, unknown>) => NotificationTemplate;

const DEFAULT_LANG: NotificationLang = "TH";

const WORKER_NOTIFICATION_KEYS: Record<string, string> = {
  WORKER_ASSIGNED: "worker.assigned",
  ASSIGNMENT_TIMEOUT: "assignment.timeout",
  ASSIGNMENT_CANCELLED: "assignment.cancelled",
  TEAM_READY: "assignment.team_ready",
  ASSIGNMENT_SCAN_DEADLINE_EXTENDED: "assignment.scan_deadline_extended",
  ASSIGNMENT_SCAN_DEADLINE_SHORTENED: "assignment.scan_deadline_shortened",
  ASSIGNMENT_SCAN_DEADLINE_WARNING: "assignment.scan_deadline_warning",
  TICKET_COMPLETION_SUBMITTED: "ticket.completion_submitted",
  TICKET_COMPLETION_RESULT: "ticket.completion_result",
  STALL_JOB_CANCELLED: "job.stall_cancelled",
  MARKET_JOB_CANCELLED: "job.market_cancelled",
  VEHICLE_JOB_CANCELLED: "job.vehicle_cancelled",
  SESSION_REVOKED: "auth.session_revoked",
  APP_VERSION_UPDATE: "app.version_update",
  APP_VERSION_FORCE_UPDATE: "app.version_force_update",
};

function text(value: unknown, fallback = "-"): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberText(value: unknown, fallback = "-"): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  return fallback;
}

function resolveTicketResultKey(params: Record<string, unknown>): string {
  const submissionStatus = String(params.submission_status ?? params.status ?? "").toUpperCase();

  if (submissionStatus === TICKET_STATUS.COMPLETED) {
    return "ticket.completion_confirmed";
  }

  if (submissionStatus === TICKET_STATUS.REJECT) {
    return "ticket.completion_rejected";
  }

  return "ticket.completion_result";
}

function normalizeNotificationLang(value?: string | null): NotificationLang {
  const lang = String(value ?? "").trim().toUpperCase();

  if (lang === "TH" || lang === "MN" || lang === "CN" || lang === "EN") {
    return lang;
  }

  if (lang === "MY") {
    return "MN";
  }

  if (lang === "KM") {
    return "CN";
  }

  return DEFAULT_LANG;
}

function resolveWorkerNotificationKey(
  type: string,
  params: Record<string, unknown> = {},
  explicitKey?: string | null,
): string {
  if (explicitKey) {
    return explicitKey;
  }

  if (type === "TICKET_COMPLETION_RESULT") {
    return resolveTicketResultKey(params);
  }

  return WORKER_NOTIFICATION_KEYS[type] ?? "worker.notification";
}

const TEMPLATES: Record<NotificationLang, Record<string, TemplateRenderer>> = {
  TH: {
    "worker.assigned": () => ({
      title: "มีงานใหม่",
      message: "คุณได้รับงานใหม่ กรุณากดรับงาน",
    }),
    "assignment.timeout": () => ({
      title: "หมดเวลางาน",
      message: "หมดเวลารับงานหรือสแกน QR",
    }),
    "assignment.cancelled": () => ({
      title: "งานถูกยกเลิก",
      message: "งานถูกยกเลิก",
    }),
    "assignment.team_ready": () => ({
      title: "ทีมพร้อมทำงาน",
      message: "ทีมงานเช็คอินครบแล้ว เริ่มทำงานได้เลย",
    }),
    "assignment.scan_deadline_extended": () => ({
      title: "ต่อเวลาสแกน QR",
      message: "ต่อเวลาสแกน QR แล้ว",
    }),
    "assignment.scan_deadline_shortened": (params) => ({
      title: "เวลา Scan QR ถูกปรับ",
      message: `กรุณาสแกน QR ภายใน ${numberText(params.remaining_minutes)} นาที`,
    }),
    "assignment.scan_deadline_warning": (params) => ({
      title: "ใกล้หมดเวลาสแกน QR",
      message: `คุณเหลือเวลา ${numberText(params.remaining_minutes)} นาทีในการสแกน QR`,
    }),
    "ticket.completion_submitted": (params) => ({
      title: "ส่งยอดงานแล้ว",
      message: `แผง ${text(params.boothCode)} ถูกส่งยอดแล้ว รอแผงค้ายืนยัน`,
    }),
    "ticket.completion_confirmed": (params) => ({
      title: "แผงค้ายืนยันยอดแล้ว",
      message: `แผง ${text(params.boothCode)} ยืนยันยอดเรียบร้อยแล้ว`,
    }),
    "ticket.completion_rejected": (params) => ({
      title: "แผงค้าตีกลับยอด",
      message: `แผง ${text(params.boothCode)} ตีกลับยอดงาน กรุณาตรวจสอบ`,
    }),
    "ticket.completion_result": (params) => ({
      title: "ผลยืนยันยอดอัปเดตแล้ว",
      message: `ผลยืนยันยอดของแผง ${text(params.boothCode)} อัปเดตแล้ว`,
    }),
    "job.stall_cancelled": (params) => ({
      title: "งานแผงถูกยกเลิก",
      message: `งานแผง ${text(params.boothCode)} ถูกยกเลิก`,
    }),
    "job.market_cancelled": (params) => ({
      title: "งานตลาดถูกยกเลิก",
      message: `งานตลาด ${text(params.marketCode)} ถูกยกเลิก`,
    }),
    "job.vehicle_cancelled": () => ({
      title: "งานรถถูกยกเลิก",
      message: "งานรถถูกยกเลิก",
    }),
    "auth.session_revoked": (params) => ({
      title: "บัญชีถูกเข้าสู่ระบบจากอุปกรณ์อื่น",
      message: `Session นี้ถูกออกจากระบบ เนื่องจากมีการยืนยันเข้าสู่ระบบจาก ${text(params.new_device_name, "อุปกรณ์อื่น")}`,
    }),
    "app.version_update": (params) => ({
      title: "มีแอปพลิเคชันเวอร์ชันใหม่",
      message: params.force_update_date
        ? `เวอร์ชัน ${text(params.version)} พร้อมให้อัปเดต และจะเริ่มบังคับอัปเดตวันที่ ${text(params.force_update_date)} เวลา ${text(params.force_update_time)} น.`
        : `เวอร์ชัน ${text(params.version)} พร้อมให้อัปเดตแล้ว`,
    }),
    "app.version_force_update": (params) => ({
      title: "ถึงเวลาบังคับอัปเดตแล้ว",
      message: `ขณะนี้แอปพลิเคชันมีเวอร์ชันใหม่ ${text(params.version)} กรุณาอัปเดตแอปเพื่อใช้งานต่อ`,
    }),
    "worker.notification": () => ({
      title: "แจ้งเตือนงาน",
      message: "มีแจ้งเตือนงานใหม่",
    }),
  },
  MN: {
    "worker.assigned": () => ({
      title: "အလုပ်အသစ် ရရှိပါသည်",
      message: "အလုပ်အသစ် ရရှိပါသည်။ လက်ခံပါ။",
    }),
    "assignment.timeout": () => ({
      title: "အချိန်ကျော်လွန်သွားပါသည်",
      message: "အလုပ်လက်ခံရန် သို့မဟုတ် QR စကန်ရန် အချိန်ကျော်လွန်သွားပါသည်။",
    }),
    "assignment.cancelled": () => ({
      title: "အလုပ်ကို ပယ်ဖျက်ပြီးပါပြီ",
      message: "အလုပ်ကို ပယ်ဖျက်ပြီးပါပြီ။",
    }),
    "assignment.team_ready": () => ({
      title: "အသင်း အသင့်ဖြစ်ပါပြီ",
      message: "အဖွဲ့ဝင်အားလုံး check-in ပြုလုပ်ပြီးပါပြီ။ အလုပ်စတင်နိုင်ပါပြီ။",
    }),
    "assignment.scan_deadline_extended": () => ({
      title: "QR စကန်ချိန် တိုးပြီးပါပြီ",
      message: "QR စကန်ချိန် တိုးပြီးပါပြီ။",
    }),
    "assignment.scan_deadline_shortened": (params) => ({
      title: "QR စကန်ချိန် ပြောင်းလဲပါသည်",
      message: `${numberText(params.remaining_minutes)} မိနစ်အတွင်း QR စကန်ပါ။`,
    }),
    "assignment.scan_deadline_warning": (params) => ({
      title: "QR စကန်ချိန် သတိပေးချက်",
      message: `သင့်တွင် QR စကန်ရန် ${numberText(params.remaining_minutes)} မိနစ် ကျန်ရှိပါသည်။`,
    }),
    "ticket.completion_submitted": (params) => ({
      title: "အလုပ်ပမာဏ ပို့ပြီးပါပြီ",
      message: `ဆိုင်ခန်း ${text(params.boothCode)} ၏ အလုပ်ပမာဏ ပို့ပြီးပါပြီ။ အတည်ပြုချက် စောင့်နေပါသည်။`,
    }),
    "ticket.completion_confirmed": (params) => ({
      title: "ဆိုင်ခန်းမှ အတည်ပြုပြီးပါပြီ",
      message: `ဆိုင်ခန်း ${text(params.boothCode)} မှ အလုပ်ပမာဏကို အတည်ပြုပြီးပါပြီ။`,
    }),
    "ticket.completion_rejected": (params) => ({
      title: "ဆိုင်ခန်းမှ ပြန်ပို့ထားပါသည်",
      message: `ဆိုင်ခန်း ${text(params.boothCode)} မှ အလုပ်ပမာဏကို ပြန်ပို့ထားပါသည်။ စစ်ဆေးပါ။`,
    }),
    "ticket.completion_result": (params) => ({
      title: "အတည်ပြုရလဒ် ပြောင်းလဲပါသည်",
      message: `ဆိုင်ခန်း ${text(params.boothCode)} ၏ အတည်ပြုရလဒ် ပြောင်းလဲပါသည်။`,
    }),
    "job.stall_cancelled": (params) => ({
      title: "ဆိုင်ခန်းအလုပ် ပယ်ဖျက်ပြီးပါပြီ",
      message: `ဆိုင်ခန်း ${text(params.boothCode)} ၏ အလုပ်ကို ပယ်ဖျက်ပြီးပါပြီ။`,
    }),
    "job.market_cancelled": (params) => ({
      title: "ဈေးအလုပ် ပယ်ဖျက်ပြီးပါပြီ",
      message: `ဈေး ${text(params.marketCode)} ၏ အလုပ်ကို ပယ်ဖျက်ပြီးပါပြီ။`,
    }),
    "job.vehicle_cancelled": () => ({
      title: "ယာဉ်အလုပ် ပယ်ဖျက်ပြီးပါပြီ",
      message: "ယာဉ်အလုပ်ကို ပယ်ဖျက်ပြီးပါပြီ။",
    }),
    "auth.session_revoked": (params) => ({
      title: "အကောင့်ကို အခြားစက်မှ ဝင်ရောက်ထားပါသည်",
      message: `${text(params.new_device_name, "အခြားစက်")} မှ ဝင်ရောက်မှုကို အတည်ပြုထားသောကြောင့် ဤ session မှ ထွက်ထားပါသည်။`,
    }),
    "app.version_update": (params) => ({
      title: "အက်ပလီကေးရှင်း ဗားရှင်းအသစ် ရရှိနိုင်ပါပြီ",
      message: params.force_update_date
        ? `ဗားရှင်း ${text(params.version)} ကို update လုပ်နိုင်ပါပြီ။ ${text(params.force_update_date)} ရက် ${text(params.force_update_time)} မှစပြီး မဖြစ်မနေ update လုပ်ရပါမည်။`
        : `ဗားရှင်း ${text(params.version)} ကို update လုပ်နိုင်ပါပြီ။`,
    }),
    "app.version_force_update": (params) => ({
      title: "မဖြစ်မနေ update လုပ်ရမည့်အချိန် ရောက်ရှိပါပြီ",
      message: `ယခု အက်ပလီကေးရှင်း ဗားရှင်းအသစ် ${text(params.version)} ရှိပါပြီ။ ဆက်လက်အသုံးပြုရန် update လုပ်ပါ။`,
    }),
    "worker.notification": () => ({
      title: "အလုပ်အသိပေးချက်",
      message: "အလုပ်အသိပေးချက် အသစ်ရှိပါသည်။",
    }),
  },
  CN: {
    "worker.assigned": () => ({
      title: "មានការងារថ្មី",
      message: "អ្នកទទួលបានការងារថ្មី សូមចុចទទួលការងារ",
    }),
    "assignment.timeout": () => ({
      title: "ផុតពេលការងារ",
      message: "ផុតពេលទទួលការងារ ឬ scan QR",
    }),
    "assignment.cancelled": () => ({
      title: "ការងារត្រូវបានលុបចោល",
      message: "ការងារត្រូវបានលុបចោល",
    }),
    "assignment.team_ready": () => ({
      title: "ក្រុមរួចរាល់ហើយ",
      message: "សមាជិកក្រុមទាំងអស់បាន check-in រួចរាល់ហើយ។ អាចចាប់ផ្តើមធ្វើការបានហើយ។",
    }),
    "assignment.scan_deadline_extended": () => ({
      title: "បានបន្ថែមពេល scan QR",
      message: "បានបន្ថែមពេល scan QR ហើយ",
    }),
    "assignment.scan_deadline_shortened": (params) => ({
      title: "ពេល Scan QR ត្រូវបានកែប្រែ",
      message: `សូម scan QR ក្នុងរយៈពេល ${numberText(params.remaining_minutes)} នាទី`,
    }),
    "assignment.scan_deadline_warning": (params) => ({
      title: "ការរំលឹកម៉ោង Scan QR",
      message: `អ្នកនៅសល់ពេល ${numberText(params.remaining_minutes)} នាទីដើម្បី scan QR`,
    }),
    "ticket.completion_submitted": (params) => ({
      title: "បានផ្ញើចំនួនការងារ",
      message: `តូប ${text(params.boothCode)} បានផ្ញើចំនួនការងារ ហើយកំពុងរង់ចាំការបញ្ជាក់`,
    }),
    "ticket.completion_confirmed": (params) => ({
      title: "តូបបានបញ្ជាក់ចំនួនហើយ",
      message: `តូប ${text(params.boothCode)} បានបញ្ជាក់ចំនួនការងាររួចរាល់`,
    }),
    "ticket.completion_rejected": (params) => ({
      title: "តូបបានបដិសេធចំនួន",
      message: `តូប ${text(params.boothCode)} បានបដិសេធចំនួនការងារ សូមពិនិត្យមើល`,
    }),
    "ticket.completion_result": (params) => ({
      title: "លទ្ធផលបញ្ជាក់បានធ្វើបច្ចុប្បន្នភាព",
      message: `លទ្ធផលបញ្ជាក់របស់តូប ${text(params.boothCode)} បានធ្វើបច្ចុប្បន្នភាព`,
    }),
    "job.stall_cancelled": (params) => ({
      title: "ការងារតូបត្រូវបានលុបចោល",
      message: `ការងារតូប ${text(params.boothCode)} ត្រូវបានលុបចោល`,
    }),
    "job.market_cancelled": (params) => ({
      title: "ការងារផ្សារត្រូវបានលុបចោល",
      message: `ការងារផ្សារ ${text(params.marketCode)} ត្រូវបានលុបចោល`,
    }),
    "job.vehicle_cancelled": () => ({
      title: "ការងាររថយន្តត្រូវបានលុបចោល",
      message: "ការងាររថយន្តត្រូវបានលុបចោល",
    }),
    "auth.session_revoked": (params) => ({
      title: "គណនីបានចូលពីឧបករណ៍ផ្សេង",
      message: `Session នេះត្រូវបានចេញ ព្រោះបានបញ្ជាក់ការចូលពី ${text(params.new_device_name, "ឧបករណ៍ផ្សេង")}`,
    }),
    "app.version_update": (params) => ({
      title: "កម្មវិធីមានកំណែថ្មី",
      message: params.force_update_date
        ? `កំណែ ${text(params.version)} អាចធ្វើបច្ចុប្បន្នភាពបានហើយ ហើយនឹងចាប់ផ្តើមតម្រូវឱ្យធ្វើបច្ចុប្បន្នភាពនៅថ្ងៃទី ${text(params.force_update_date)} ម៉ោង ${text(params.force_update_time)} ។`
        : `កំណែ ${text(params.version)} អាចធ្វើបច្ចុប្បន្នភាពបានហើយ។`,
    }),
    "app.version_force_update": (params) => ({
      title: "ដល់ពេលត្រូវធ្វើបច្ចុប្បន្នភាពជាចាំបាច់ហើយ",
      message: `ឥឡូវនេះកម្មវិធីមានកំណែថ្មី ${text(params.version)} សូមធ្វើបច្ចុប្បន្នភាពដើម្បីបន្តប្រើប្រាស់`,
    }),
    "worker.notification": () => ({
      title: "ការជូនដំណឹងការងារ",
      message: "មានការជូនដំណឹងការងារថ្មី",
    }),
  },
  EN: {
    "worker.assigned": () => ({
      title: "New assignment",
      message: "You have a new assignment. Please accept it.",
    }),
    "assignment.timeout": () => ({
      title: "Assignment timed out",
      message: "The acceptance or QR scan deadline expired.",
    }),
    "assignment.cancelled": () => ({
      title: "Assignment cancelled",
      message: "Your assignment was cancelled.",
    }),
    "assignment.team_ready": () => ({
      title: "Team ready",
      message: "Your whole team has checked in. You can start working now.",
    }),
    "assignment.scan_deadline_extended": () => ({
      title: "Scan deadline extended",
      message: "The QR scan deadline was extended.",
    }),
    "assignment.scan_deadline_shortened": (params) => ({
      title: "Scan deadline updated",
      message: `Please scan QR within ${numberText(params.remaining_minutes)} minutes.`,
    }),
    "assignment.scan_deadline_warning": (params) => ({
      title: "Scan deadline reminder",
      message: `You have ${numberText(params.remaining_minutes)} minutes left to scan the QR code.`,
    }),
    "ticket.completion_submitted": (params) => ({
      title: "Ticket submitted",
      message: `Booth ${text(params.boothCode)} was submitted and is waiting for vendor confirmation.`,
    }),
    "ticket.completion_confirmed": (params) => ({
      title: "Vendor confirmed",
      message: `Booth ${text(params.boothCode)} has been confirmed.`,
    }),
    "ticket.completion_rejected": (params) => ({
      title: "Vendor rejected",
      message: `Booth ${text(params.boothCode)} was rejected. Please review it.`,
    }),
    "ticket.completion_result": (params) => ({
      title: "Ticket result updated",
      message: `The confirmation result for booth ${text(params.boothCode)} was updated.`,
    }),
    "job.stall_cancelled": (params) => ({
      title: "Stall job cancelled",
      message: `Stall job ${text(params.boothCode)} was cancelled.`,
    }),
    "job.market_cancelled": (params) => ({
      title: "Market job cancelled",
      message: `Market job ${text(params.marketCode)} was cancelled.`,
    }),
    "job.vehicle_cancelled": () => ({
      title: "Vehicle job cancelled",
      message: "Your vehicle job was cancelled.",
    }),
    "auth.session_revoked": (params) => ({
      title: "Signed in on another device",
      message: `This session was signed out because login was confirmed on ${text(params.new_device_name, "another device")}.`,
    }),
    "app.version_update": (params) => ({
      title: "New app version available",
      message: params.force_update_date
        ? `Version ${text(params.version)} is ready to update, and will be required starting ${text(params.force_update_date)} at ${text(params.force_update_time)}.`
        : `Version ${text(params.version)} is ready to update.`,
    }),
    "app.version_force_update": (params) => ({
      title: "Update is now required",
      message: `A new app version ${text(params.version)} is now available. Please update to continue.`,
    }),
    "worker.notification": () => ({
      title: "Worker notification",
      message: "A worker notification is available.",
    }),
  },
};

// Function เช็คว่า notification_key ที่บันทึกไว้ยังมี template รองรับภาษานั้นอยู่จริงหรือไม่ — ใช้ตอน
// render ประวัติแจ้งเตือนเก่าใหม่ตามภาษาปัจจุบันของ worker กัน key ที่ถูกลบ/เปลี่ยนชื่อไปแล้วในโค้ดรุ่นหลัง
// ตกไปโชว์เป็นข้อความ generic "worker.notification" แทนเนื้อหาจริงในอดีต
export function hasNotificationTemplate(lang: string | null | undefined, key: string): boolean {
  return Boolean(TEMPLATES[normalizeNotificationLang(lang)][key]);
}

export function buildLocalizedNotification(input: {
  type: string;
  lang?: string | null;
  key?: string | null;
  params?: Record<string, unknown>;
  fallbackTitle?: string;
  fallbackMessage?: string;
}): LocalizedNotification {
  const lang = normalizeNotificationLang(input.lang);
  const key = resolveWorkerNotificationKey(input.type, input.params, input.key);
  const renderer = TEMPLATES[lang][key] ?? TEMPLATES[lang]["worker.notification"];
  const rendered = renderer(input.params ?? {});

  return {
    key,
    lang,
    title: rendered.title || input.fallbackTitle || TEMPLATES[lang]["worker.notification"]({}).title,
    message: rendered.message || input.fallbackMessage || TEMPLATES[lang]["worker.notification"]({}).message,
  };
}
