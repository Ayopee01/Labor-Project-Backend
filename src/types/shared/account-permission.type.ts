import type { AdminPermission } from "../../config/permission.config";
import type { AccountStatus } from "./account.type";

export interface AccountPermissionsResponse {
  account_id: number;
  role: string;
  status: AccountStatus;
  permission_level: string | null;
  permissions: AdminPermission[];
}
