// Import Repositories
import * as permissionRepository from "../../repositories/shared/permission.repository";
// Import Types
import type { AccountPermissionsResponse } from "../../types/shared/account-permission.type";
import type { AccountDto } from "../../types/admin-workers.type";
import type { DbConnection } from "../../types/shared/common.type";

// Function ดึง permission ทั้งหมดของ account พร้อมข้อมูล role/status
export async function getAccountPermissions(
  account: AccountDto,
  connection?: DbConnection,
): Promise<AccountPermissionsResponse> {
  return {
    account_id: account.id,
    role: account.role,
    status: account.status,
    permission_level: account.permission_level,
    permissions: await permissionRepository.listByAccountId(
      account.id,
      connection,
    ),
  };
}
