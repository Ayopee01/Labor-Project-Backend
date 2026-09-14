// ตั้งค่าตัวแปร "shuttingDown" เริ่มต้นเป็น False
let shuttingDown = false;

// หาก Process กำลังจะ Shutdown ให้เปลี่ยน shuttingDown เป็น true
export function markReadinessShuttingDown(): void {
  shuttingDown = true;
}

// Function ตรวจสอบ Status เป็น True or False และ Return "shuttingDown"
export function isReadinessShuttingDown(): boolean {
  return shuttingDown;
}
