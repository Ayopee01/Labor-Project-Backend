// Function คำนวณจำนวน Worker ที่รถต้องมีจริงตอนนี้ = workers_required - จำนวนที่ Admin ถอดออกหลัง Scan แล้ว
// workers_required คงค่าเดิมไว้ให้ Admin เห็นขนาดทีมตั้งต้นและเพิ่มคนกลับเข้าไปได้ ส่วน dispatch และความพร้อมทีม
// (is_ready ที่ใช้ตัดสินว่าส่งยอดได้หรือยัง) ต้องใช้ค่านี้เสมอ ไม่งั้นระบบจะหาคนแทนเองและทีมที่เหลือส่งยอดไม่ได้
export function resolveEffectiveWorkersRequired(
  workersRequired: number,
  removedAfterScanCount: number | null | undefined,
): number {
  return Math.max(0, workersRequired - (removedAfterScanCount ?? 0));
}
