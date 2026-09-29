// Function คำนวณจำนวน worker ที่รถต้องมีจริง = workers_required - คนที่ถูกถอดหลัง scan (ใช้กับ dispatch)
export function resolveEffectiveWorkersRequired(
  workersRequired: number,
  removedAfterScanCount: number | null | undefined,
): number {
  return Math.max(0, workersRequired - (removedAfterScanCount ?? 0));
}

// Function คำนวณจำนวนคนที่ต้อง scan ครบก่อนทีมพร้อม = จำนวนที่ต้องมีจริง แต่ไม่ต่ำกว่า 1
export function resolveTeamReadinessThreshold(
  workersRequired: number,
  removedAfterScanCount: number | null | undefined,
): number {
  if (workersRequired <= 0) {
    return 0;
  }

  return Math.max(1, resolveEffectiveWorkersRequired(workersRequired, removedAfterScanCount));
}
