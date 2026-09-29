// Import Types
import type { RuntimeSettings } from "../config/runtime.config";
import type { AccountStatus } from "./shared/account.type";
import type { PublicGateClient } from "./shared/gate-client.type";
import type { AccountPermissionsResponse } from "./shared/account-permission.type";

// Type ส่วน Response ของ runtime settings
export type RuntimeSettingsResponse = RuntimeSettings;

export type { AccountPermissionsResponse };

// Type ข้อมูล account ของ Admin ในรายการ role
interface AdminRoleAccountSummary {
  id: number;
  username: string;
  full_name: string;
  position: string | null;
  status: AccountStatus;
  email: string | null;
  phone: string | null;
  created_at: string;
  updated_at: string;
}

// Type Admin หนึ่งคนพร้อมสิทธิ์ในรายการ role
interface AdminRoleListItem {
  key: string;
  name: string;
  order: number;
  admins: AdminRoleAccountSummary[];
}

// Type ส่วน Response ของรายการ role
export interface AdminRoleListResponse {
  data: AdminRoleListItem[];
}

// Type response รายการ Gate client ใน Admin Settings
export interface GateClientListResponse {
  data: PublicGateClient[];
}

// Type response หลังอัปเดต metadata ที่แสดงได้ของ Gate client
export interface GateClientMutationResponse extends PublicGateClient {
  message: string;
}

// Type response หลังสร้างหรือ rotate secret ของ Gate client
export interface GateClientSecretResponse extends GateClientMutationResponse {
  client_secret: string;
}
