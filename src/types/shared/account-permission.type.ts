// Import Config
import type { AdminPermission } from "../../config/permission.config";
// Import Types
import type { AccountStatus } from "./account.type";

// Type ส่วน Response สิทธิ์ของ account
export interface AccountPermissionsResponse {
  account_id: number;
  role: string;
  status: AccountStatus;
  permission_level: string | null;
  permissions: AdminPermission[];
}
