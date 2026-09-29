// Import Config
import { isAdminPermission } from "../../config/permission.config";
// Import Utils
import { client } from "./repository-utils";
// Import Types
import type { AdminPermission } from "../../config/permission.config";
import type { DbConnection } from "../../types/shared/common.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function แปลง permission string จาก DB เป็น AdminPermission (null ถ้าไม่รู้จัก)
function toAdminPermission(permission: string): AdminPermission | null {
  return isAdminPermission(permission) ? permission : null;
}

// Function ดึงรายการ permission ตาม account id จาก DB
export async function listByAccountId(
  accountId: number,
  connection?: DbConnection
): Promise<AdminPermission[]> {
  const db = client(connection);
  const records = await db.accountPermission.findMany({
    where: {
      accountId,
    },
    orderBy: {
      permission: "asc",
    },
  });

  return records
    .map((record) => toAdminPermission(record.permission))
    .filter((permission): permission is AdminPermission => permission !== null);
}

// Function แทนที่ permissions ทั้งหมดของ account นี้ด้วยชุดใหม่ (ลบของเก่าแล้วสร้างใหม่)
export async function replaceAccountPermissions(
  accountId: number,
  permissions: AdminPermission[],
  connection?: DbConnection
): Promise<void> {
  const db = client(connection);

  await db.accountPermission.deleteMany({
    where: {
      accountId,
    },
  });

  if (permissions.length === 0) {
    return;
  }

  await db.accountPermission.createMany({
    data: permissions.map((permission) => ({
      accountId,
      permission,
    })),
    skipDuplicates: true,
  });
}
