// Import Types
import type { AdminPermission } from "../../config/permission.config";
import type { AccountStatus } from "./account.type";

// Type ส่วน Response สิทธิ์ของ account
export interface AccountPermissionsResponse {
  account_id: number;
  role: string;
  status: AccountStatus;
  permission_level: string | null;
  permissions: AdminPermission[];
}
