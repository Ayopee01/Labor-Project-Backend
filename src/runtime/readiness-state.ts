/* -------------------------------------- Config -------------------------------------- */

// Config สถานะว่า process กำลัง shutdown หรือไม่
let shuttingDown = false;

/* -------------------------------------- Functions -------------------------------------- */

// Function ตั้งสถานะว่า process กำลัง shutdown
export function markReadinessShuttingDown(): void {
  shuttingDown = true;
}

// Function ตรวจว่า process กำลัง shutdown หรือไม่
export function isReadinessShuttingDown(): boolean {
  return shuttingDown;
}
