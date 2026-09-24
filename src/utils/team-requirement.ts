// Function คำนวณจำนวน Worker ที่รถต้องมีจริงตอนนี้ = workers_required - จำนวนที่ Admin ถอดออกหลัง Scan แล้ว
// workers_required คงค่าเดิมไว้ให้ Admin เห็นขนาดทีมตั้งต้นและเพิ่มคนกลับเข้าไปได้ — dispatch ต้องใช้ค่านี้
// (อาจเป็น 0 เมื่อ Admin ถอดทุกคนออกหลังมีแผงทำเสร็จ/ส่งยอดแล้ว) ระบบจึงไม่หาคนแทนเอง
export function resolveEffectiveWorkersRequired(
  workersRequired: number,
  removedAfterScanCount: number | null | undefined,
): number {
  return Math.max(0, workersRequired - (removedAfterScanCount ?? 0));
}

// Function คำนวณเกณฑ์ความพร้อมของทีม (จำนวนคนที่ต้อง Scan ครบก่อนส่งยอดได้) และเกณฑ์สถานะงานรถ = จำนวนที่ต้องมีจริง
// แต่ไม่ต่ำกว่า 1 — กรณี Admin ถอดทุกคนออกแล้วเพิ่มคนใหม่เข้าไปทำต่อ ทีมจะพร้อมเมื่อคนใหม่ Scan อย่างน้อย 1 คน
// (ใช้ resolveEffectiveWorkersRequired ตรงๆ ไม่ได้ เพราะเกณฑ์ 0 จะทำให้ทีมไม่มีวันพร้อม)
export function resolveTeamReadinessThreshold(
  workersRequired: number,
  removedAfterScanCount: number | null | undefined,
): number {
  if (workersRequired <= 0) {
    return 0;
  }

  return Math.max(1, resolveEffectiveWorkersRequired(workersRequired, removedAfterScanCount));
}
