// Config สถานะของ Gate client
export const GATE_CLIENT_STATUSES = ["active", "inactive"] as const;

// Type สถานะของ Gate client
export type GateClientStatus = (typeof GATE_CLIENT_STATUSES)[number];

// Type ส่วน DTO ของ Gate client
export interface GateClientDto {
  id: number;
  client_id: string;
  name: string;
  secret_hash: string;
  status: GateClientStatus;
  last_used_at: string | null;
  created_by: number | null;
  updated_by: number | null;
  created_at: string;
  updated_at: string;
}

// Type Gate client ที่ตัด secret_hash ออกแล้ว
export type PublicGateClient = Omit<GateClientDto, "secret_hash">;

// Type ส่วน Repository input สำหรับสร้าง Gate client
export interface GateClientCreateInput {
  client_id: string;
  name: string;
  secret_hash: string;
  status?: GateClientStatus;
  created_by?: number | null;
  updated_by?: number | null;
}

// Type ส่วน Repository input สำหรับแก้ไข Gate client
export interface GateClientUpdateInput {
  name?: string;
  status?: GateClientStatus;
  updated_by?: number | null;
}
