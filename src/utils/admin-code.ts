/* -------------------------------------- Functions -------------------------------------- */

// Function สร้างรหัสพนักงานของ Admin จาก account id (เช่น ADM0001) ใช้เป็นชื่อไฟล์รูปโปรไฟล์ด้วย
export function buildAdminEmployeeCode(accountId: number): string {
  return `ADM${String(accountId).padStart(4, "0")}`;
}
