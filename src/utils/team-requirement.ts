// Function คำนวณจำนวน worker ที่รถต้องมีจริง = workers_required - ช่องที่ยังไม่ได้เติม (ใช้กับ dispatch)
export function resolveEffectiveWorkersRequired(
  workersRequired: number,
  unfilledSlotCount: number | null | undefined,
): number {
  return Math.max(0, workersRequired - (unfilledSlotCount ?? 0));
}

// Function คำนวณจำนวนคนที่ต้อง scan ครบก่อนทีมพร้อม = จำนวนที่ต้องมีจริง แต่ไม่ต่ำกว่า 1
export function resolveTeamReadinessThreshold(
  workersRequired: number,
  unfilledSlotCount: number | null | undefined,
): number {
  if (workersRequired <= 0) {
    return 0;
  }

  return Math.max(1, resolveEffectiveWorkersRequired(workersRequired, unfilledSlotCount));
}
