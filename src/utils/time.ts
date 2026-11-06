// Import Library
import { tz } from "@date-fns/tz";
import { addDays, addMinutes, eachDayOfInterval, format, formatDuration, isValid, parseISO, startOfDay, subDays } from "date-fns";
// Import Types
import type { WorkerStatusResponse } from "../types/worker.type";

/* -------------------------------------- Config -------------------------------------- */

// Config timezone ไทย
export const BANGKOK_TIME_ZONE = "Asia/Bangkok";
// Config context ของ date-fns ให้คำนวณ/แสดงผลตามเวลาไทย
const inBangkok = { in: tz(BANGKOK_TIME_ZONE) };

/* -------------------------------------- Functions -------------------------------------- */

// Function สร้างเวลา deadline จากเวลาฐาน + durationMs
export function buildDeadline(durationMs: number, baseTime = Date.now()): Date {
  return new Date(baseTime + durationMs);
}

// Function หาจำนวน ms ที่เหลือจนถึง deadline (ไม่ติดลบ)
export function getDelayUntil(deadlineAt: string | null, baseTime = Date.now()): number {
  if (!deadlineAt) {
    return 0;
  }

  const deadlineMs = new Date(deadlineAt).getTime();

  if (!Number.isFinite(deadlineMs)) {
    return 0;
  }

  return Math.max(0, deadlineMs - baseTime);
}

// Function แปลง ISO string เป็น unix ms (ไม่มีค่าหรือผิดรูปแบบคืน null)
export function toUnixMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const timeMs = new Date(value).getTime();

  return Number.isFinite(timeMs) ? timeMs : null;
}

// Function แปลงผลลัพธ์ของ date-fns (TZDate) กลับเป็น Date ปกติ (TZDate.toISOString ใส่ +07:00 แทน Z)
function toPlainDate(value: Date): Date {
  return new Date(value.getTime());
}

// Function แปลงวันที่/เวลา YYYY-MM-DD หรือ YYYY-MM-DDTHH:mm ตามเวลาไทยเป็น Date
function parseBangkok(value: string): Date {
  return parseISO(value, inBangkok);
}

// Function สร้างช่วงเวลาทั้งวันตามเวลาไทยของวันที่ที่ระบุ
export function buildBangkokDateRange(date: string): { startAt: Date; endAt: Date } {
  const startAt = parseBangkok(date);

  return {
    startAt: toPlainDate(startAt),
    endAt: toPlainDate(addDays(startAt, 1)),
  };
}

// Function สร้างช่วงเวลาของ N วันล่าสุดที่จบแล้ว (ไม่รวมวันนี้) ตามเวลาไทย
export function buildLatestCompletedBangkokDateRange(
  dayCount: number,
  baseDate: Date = new Date()
): { startAt: Date; endAt: Date; dates: string[] } {
  const endAt = startOfDay(baseDate, inBangkok);
  const startAt = subDays(endAt, dayCount);
  const dates = eachDayOfInterval({ start: startAt, end: subDays(endAt, 1) }, inBangkok).map((date) =>
    formatBangkokDate(date)
  );

  return {
    startAt: toPlainDate(startAt),
    endAt: toPlainDate(endAt),
    dates,
  };
}

// Function สร้างช่วงเวลาจาก dateFrom-dateTo ตามเวลาไทย (timeTo นับรวมทั้งนาทีนั้น)
export function buildBangkokDateSpanRange(
  dateFrom?: string,
  dateTo?: string,
  timeFrom?: string,
  timeTo?: string
): { startAt?: Date; endAt?: Date } {
  return {
    ...(dateFrom && {
      startAt: toPlainDate(parseBangkok(`${dateFrom}T${timeFrom ?? "00:00"}`)),
    }),
    ...(dateTo && {
      endAt: toPlainDate(
        timeTo ? addMinutes(parseBangkok(`${dateTo}T${timeTo}`), 1) : addDays(parseBangkok(dateTo), 1)
      ),
    }),
  };
}

// Function แปลง Date เป็นวันที่ YYYY-MM-DD ตามเวลาไทย
export function formatBangkokDate(value: Date = new Date()): string {
  return format(value, "yyyy-MM-dd", inBangkok);
}

// Function แปลงวันที่เป็นรูปแบบแสดงผล DD/MM/YYYY ตามเวลาไทย (ไม่มีค่าคืน "-")
export function formatBangkokDisplayDate(value: Date | string | null | undefined): string {
  if (!value) {
    return "-";
  }

  const date = new Date(value);

  return isValid(date) ? format(date, "dd/MM/yyyy", inBangkok) : "-";
}

// Function แปลงวันเวลาเป็นรูปแบบแสดงผลตามเวลาไทย
export function formatBangkokDisplayDateTime(value: Date | string): string {
  return format(new Date(value), "dd/MM/yyyy HH:mm:ss", inBangkok);
}

// Function คำนวณเวลาพักที่เหลือสำหรับ response หน้า status ของ Worker
export function buildRemainingBreakTime(
  breakUntil: string | null | undefined
): WorkerStatusResponse["remaining_break_time"] | null {
  if (!breakUntil) {
    return null;
  }

  const breakUntilMs = new Date(breakUntil).getTime();

  if (Number.isNaN(breakUntilMs)) {
    return null;
  }

  const totalSeconds = Math.max(
    0,
    Math.ceil((breakUntilMs - Date.now()) / 1000)
  );
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return {
    total_seconds: totalSeconds,
    minutes,
    seconds,
    // formatDuration ข้ามหน่วยที่เป็น 0 จึงต้องเติม "0 seconds" เองเมื่อหมดเวลาพักแล้ว
    text: formatDuration({ minutes, seconds }) || "0 seconds",
  };
}
