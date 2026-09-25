// Import Dependencies
import type { ShiftWaitInfo, WorkScheduleDto } from "../types/admin-workers.type";
import ApiError from "./api-error";
import { BANGKOK_TIME_ZONE, formatBangkokDate } from "./time";

/* -------------------------------------- Config -------------------------------------- */

const bangkokTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: BANGKOK_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/* -------------------------------------- Functions -------------------------------------- */

// Function อ่านค่า time เป็น minutes สำหรับ helper กลาง
function parseTimeToMinutes(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }

  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);

  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  return hours * 60 + minutes;
}

// Function ดึง bangkok time เป็น minutes สำหรับ helper กลาง
function getBangkokTimeToMinutes(value: Date): number {
  const parts = bangkokTimeFormatter.formatToParts(value);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);

  return hour * 60 + minute;
}

// Function จัดการ add days เป็น date string สำหรับ helper กลาง
function addDaysToDateString(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));

  return [
    String(next.getUTCFullYear()),
    String(next.getUTCMonth() + 1).padStart(2, "0"),
    String(next.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

// Function หาวันที่เริ่มกะจริงของ schedule ณ เวลาที่ระบุ (ย้อนกลับ 1 วันถ้ากะข้ามคืนและตอนนี้ยังอยู่
// ในช่วงเช้าของกะเดิม) ใช้ร่วมกันทั้ง shift instance key และ shift end at
function resolveShiftStartDate(
  schedule: WorkScheduleDto,
  value: Date
): string {
  const { startMinutes, endMinutes } = parseScheduleTimeRange(schedule);
  const currentMinutes = getBangkokTimeToMinutes(value);
  const currentDate = formatBangkokDate(value);

  return endMinutes <= startMinutes && currentMinutes < endMinutes
    ? addDaysToDateString(currentDate, -1)
    : currentDate;
}

// Function สร้าง work schedule shift instance key สำหรับ helper กลาง
export function buildWorkScheduleShiftInstanceKey(
  schedule: WorkScheduleDto,
  value: Date = new Date()
): string {
  const shiftStartDate = resolveShiftStartDate(schedule, value);

  return `${shiftStartDate}:${schedule.time_in}-${schedule.time_out}`;
}

// Function ดึง work schedule shift end at สำหรับ helper กลาง
function getWorkScheduleShiftEndAt(
  schedule: WorkScheduleDto,
  value: Date = new Date()
): Date {
  const { startMinutes, endMinutes } = parseScheduleTimeRange(schedule);
  const shiftStartDate = resolveShiftStartDate(schedule, value);
  const shiftEndDate =
    endMinutes <= startMinutes
      ? addDaysToDateString(shiftStartDate, 1)
      : shiftStartDate;

  return new Date(`${shiftEndDate}T${schedule.time_out}:00.000+07:00`);
}

// Function ดึง work schedule shift end delay ms สำหรับ helper กลาง
export function getWorkScheduleShiftEndDelayMs(
  schedule: WorkScheduleDto,
  value: Date = new Date()
): number {
  return Math.max(0, getWorkScheduleShiftEndAt(schedule, value).getTime() - value.getTime());
}

// Function จัดรูปแบบ remaining time สำหรับ helper กลาง
function formatRemainingTime(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const textParts = [];

  if (hours > 0) {
    textParts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  }

  if (minutes > 0 || textParts.length === 0) {
    textParts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  }

  return textParts.join(" ");
}

// Function อ่านค่า schedule time range สำหรับ helper กลาง
function parseScheduleTimeRange(schedule: WorkScheduleDto): {
  startMinutes: number;
  endMinutes: number;
} {
  const startMinutes = parseTimeToMinutes(schedule.time_in);
  const endMinutes = parseTimeToMinutes(schedule.time_out);

  if (startMinutes === null || endMinutes === null) {
    throw new ApiError(
      400,
      "INVALID_TIME_FORMAT",
      "TimeIn/TimeOut must use HH:mm format."
    );
  }

  return {
    startMinutes,
    endMinutes,
  };
}

// Function ตรวจว่า time ใน work schedule สำหรับ helper กลาง
export function isTimeInWorkSchedule(
  schedule: WorkScheduleDto,
  value: Date = new Date()
): boolean {
  const { startMinutes, endMinutes } = parseScheduleTimeRange(schedule);
  const currentMinutes = getBangkokTimeToMinutes(value);

  if (endMinutes <= startMinutes) {
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }

  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

// Function สร้าง shift wait info สำหรับ helper กลาง
export function buildShiftWaitInfo(
  schedule: WorkScheduleDto,
  value: Date = new Date()
): ShiftWaitInfo {
  const { startMinutes } = parseScheduleTimeRange(schedule);
  const currentMinutes = getBangkokTimeToMinutes(value);
  let minutesUntilShiftStart = startMinutes - currentMinutes;

  if (minutesUntilShiftStart <= 0) {
    minutesUntilShiftStart += 24 * 60;
  }

  return {
    shift: {
      name: schedule.shift_name,
      start_time: schedule.time_in,
      end_time: schedule.time_out,
    },
    remaining_time: formatRemainingTime(minutesUntilShiftStart),
  };
}
