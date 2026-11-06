/* -------------------------------------- Functions -------------------------------------- */

// Function สร้างรหัสพนักงานของ Admin จาก account id (เช่น ADM0001) ใช้เป็นชื่อไฟล์รูปโปรไฟล์ด้วย
export function buildAdminEmployeeCode(accountId: number): string {
  return `ADM${String(accountId).padStart(4, "0")}`;
}

// Function แปลง AdminCode (เช่น ADM0001) กลับเป็น account id (รับเฉพาะรูปแบบที่ buildAdminEmployeeCode สร้าง ไม่ตรงคืน null)
export function parseAdminCode(adminCode: string): number | null {
  const match = /^ADM(\d+)$/.exec(adminCode);
  const accountId = match ? Number(match[1]) : NaN;

  if (!Number.isSafeInteger(accountId) || accountId <= 0 || buildAdminEmployeeCode(accountId) !== adminCode) {
    return null;
  }

  return accountId;
}
