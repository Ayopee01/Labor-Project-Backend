// Type ส่วน DTO ของ system setting
export interface SystemSettingDto {
  key: string;
  value: string;
  updated_by: number | null;
  created_at: string;
  updated_at: string;
}
