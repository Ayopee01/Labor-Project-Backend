// Import Mappers
import { mapAccount } from "./shared/mappers";
import { client, requireMapped, toId } from "./shared/repository-utils";
// Import Types
import type { DbConnection } from "../types/shared/common.type";
import type { AccountCreateInput, AccountDto } from "../types/admin-workers.type";

/* -------------------------------------- Config -------------------------------------- */

// Config ค่า role ของ admin account
const ADMIN_ROLE = "admin";

/* -------------------------------------- Functions -------------------------------------- */

// Function ค้นหา admin account ตาม ID จาก DB
export async function findAdminById(
  id: number | string,
  connection?: DbConnection,
): Promise<AccountDto | null> {
  const db = client(connection);
  const account = await db.account.findFirst({
    where: {
      id: toId(id),
      role: ADMIN_ROLE,
    },
  });

  return mapAccount(account);
}

// Function ตรวจว่า username นี้มีอยู่ใน DB แล้วหรือไม่
export async function usernameExists(
  username: string,
  connection?: DbConnection,
): Promise<boolean> {
  const db = client(connection);
  const account = await db.account.findUnique({
    where: {
      username,
    },
    select: {
      id: true,
    },
  });

  return Boolean(account);
}

// Function สร้าง data สำหรับสร้าง admin account ใหม่
function buildAdminAccountCreateData(account: AccountCreateInput) {
  return {
    username: account.username,
    passwordHash: account.password_hash,
    role: ADMIN_ROLE,
    status: account.status ?? "active",
    fullName: account.full_name,
    position: account.position ?? null,
    email: account.email ?? null,
    phone: account.phone ?? null,
    permissionLevel: account.permission_level ?? null,
    createdBy: account.created_by ?? null,
  };
}

// Function สร้าง admin account ใหม่ลง DB
export async function createAdmin(
  account: AccountCreateInput,
  connection?: DbConnection,
): Promise<AccountDto> {
  const db = client(connection);
  const createdAccount = await db.account.create({
    data: buildAdminAccountCreateData(account),
  });

  return requireMapped(mapAccount(createdAccount), "Admin account", "create");
}

// Function อัปเดตข้อมูลพื้นฐาน (full_name/position/email/phone) ของแอดมินอีกคนหนึ่งจาก DB — เฉพาะ
// field ที่ส่งมา (ไม่ใช่ undefined) เท่านั้นที่ถูกเขียนทับ
export async function updateAdminAccount(
  id: number | string,
  fields: {
    full_name?: string;
    position?: string;
    email?: string;
    phone?: string;
  },
  connection?: DbConnection,
): Promise<AccountDto> {
  const db = client(connection);
  const updatedAccount = await db.account.update({
    where: {
      id: toId(id),
    },
    data: {
      ...(fields.full_name !== undefined ? { fullName: fields.full_name } : {}),
      ...(fields.position !== undefined ? { position: fields.position } : {}),
      ...(fields.email !== undefined ? { email: fields.email } : {}),
      ...(fields.phone !== undefined ? { phone: fields.phone } : {}),
    },
  });

  return requireMapped(mapAccount(updatedAccount), "Admin account", "update");
}

// Function อัปเดต permission level ของ account จาก DB
export async function updatePermissionLevel(
  id: number | string,
  permissionLevel?: string | null,
  connection?: DbConnection,
): Promise<AccountDto> {
  const db = client(connection);
  const updatedAccount = await db.account.update({
    where: {
      id: toId(id),
    },
    data: {
      permissionLevel: permissionLevel ?? null,
    },
  });

  return requireMapped(
    mapAccount(updatedAccount),
    "Account",
    "permission level update",
  );
}
