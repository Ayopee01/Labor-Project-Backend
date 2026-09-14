// Import Types
import type { AccountRole, AccountStatus } from "./admin-workers.type";
import type { AdminPermission } from "../config/permission.config";

/* -------------------------------------- Types -------------------------------------- */

// Type ประเภท token ที่ระบบ auth ออกให้
export type TokenType = "access" | "refresh" | "login_challenge";

// Type payload ของ access token ที่ใช้เรียก API หลัง login
export interface AccessTokenPayload {
  account_id: number;
  role: AccountRole;
  permission_level?: string | null;
  permissions?: AdminPermission[];
  session_id: number;
  token_type: "access";
  iat?: number;
  exp?: number;
}

// Type payload ของ refresh token สำหรับขอ access token ชุดใหม่
export interface RefreshTokenPayload {
  account_id: number;
  role: AccountRole;
  session_id: number;
  token_type: "refresh";
  iat?: number;
  exp?: number;
}

// Type payload ชั่วคราวเมื่อ worker ต้อง confirm-force-login
export interface LoginChallengeTokenPayload {
  account_id: number;
  role: AccountRole;
  old_session_id: number;
  new_device_id: string;
  token_type: "login_challenge";
  iat?: number;
  exp?: number;
}

// Type map payload ตามชนิด token เพื่อให้ utility เซ็นและตรวจ token ได้ถูก shape
export type TokenPayloadByType = {
  access: AccessTokenPayload;
  refresh: RefreshTokenPayload;
  login_challenge: LoginChallengeTokenPayload;
};

// Type session ที่บันทึกใน DB และผูกกับ refresh token — account_id มีความหมายสองแบบตาม role
export interface SessionDto {
  id: number;
  account_id: number;
  refresh_token_hash: string;
  device_id: string;
  device_name: string;
  ip_address: string | null;
  user_agent: string | null;
  is_active: boolean;
  last_active_at: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

// Type input สำหรับสร้าง session ที่ยังไม่ revoke
export interface PendingSessionInput {
  account_id: number;
  device_id: string;
  device_name: string;
  ip_address?: string | null;
  user_agent?: string | null;
  expires_at: string | Date;
}

// Type token response ภายใน service พร้อม session ที่สร้างแล้ว
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  session: SessionDto;
}

// Type ข้อมูลกะที่แสดงใน profile card ของเส้น me
export interface ProfileCardShift {
  name: string;
  start_time: string;
  end_time: string;
}

// Type response เส้น me สำหรับบัญชี Admin
interface AdminMeResponse {
  role: "admin";
  full_name: string;
  employee_code: string;
  position: string | null;
  admin_code: string;
  status: AccountStatus;
  email: string | null;
  phone: string | null;
  image_url: string | null;
  permission_level: string | null;
  permissions: AdminPermission[];
  lang: string;
  latest_active_at: string | null;
}

// Type response เส้น me สำหรับ Worker
interface WorkerMeResponse {
  role: "worker";
  full_name: string | null;
  worker_code: string;
  nationality: string | null;
  shirt_type: string | null;
  shirt_number: string | null;
  work_start_date: string | null;
  phone: string | null;
  lang: string;
  shift: ProfileCardShift | null;
}

// Type response รวมของเส้น me ที่แยกตาม role
export type MeResponse = AdminMeResponse | WorkerMeResponse;

// Type response สำเร็จของ login, refresh และ confirm-force-login
export interface AuthSuccessResponse {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
}

export interface UpdateLangResponse {
  message: string;
  lang: string;
}

// Type option ตอนเซ็น token
export interface TokenSignOptions {
  expiresIn?: string | number;
}

// Type config สำหรับตรวจ token แต่ละชนิด
export interface TokenConfig {
  secret?: string;
  expiresIn: string | number;
  invalidCode: string;
  expiredCode: string;
}
