// Config สถานะของ mobile app version
export const MOBILE_APP_VERSION_STATUSES = [
  "current",
  "scheduled",
  "history",
] as const;

// Type สถานะของ mobile app version
export type MobileAppVersionStatus = (typeof MOBILE_APP_VERSION_STATUSES)[number];

// Type ส่วน DTO ของ mobile app version
export interface MobileAppVersionDto {
  id: number;
  version: string;
  build_number: number;
  release_at: string | null;
  android_download_url: string | null;
  ios_download_url: string | null;
  force_update_at: string | null;
  release_notification_at: string | null;
  release_notification_sent_at: string | null;
  force_update_notification_sent_at: string | null;
  release_message: string | null;
  release_notes: string | null;
  created_by: number | null;
  updated_by: number | null;
  created_at: string;
  updated_at: string;
}

// Type ส่วน Repository input สำหรับสร้าง mobile app version
export interface MobileAppVersionCreateInput {
  version: string;
  build_number: number;
  release_at?: string | null;
  android_download_url?: string | null;
  ios_download_url?: string | null;
  force_update_at?: string | null;
  release_notification_at?: string | null;
  release_message?: string | null;
  release_notes?: string | null;
  created_by?: number | null;
  updated_by?: number | null;
}

// Type ส่วน Repository input สำหรับแก้ไข mobile app version
export interface MobileAppVersionUpdateInput {
  version?: string;
  build_number?: number;
  release_at?: string | null;
  android_download_url?: string | null;
  ios_download_url?: string | null;
  force_update_at?: string | null;
  release_notification_at?: string | null;
  release_notification_sent_at?: string | null;
  force_update_notification_sent_at?: string | null;
  release_message?: string | null;
  release_notes?: string | null;
  updated_by?: number | null;
}
