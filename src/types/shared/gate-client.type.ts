export const GATE_CLIENT_STATUSES = ["active", "inactive"] as const;

export type GateClientStatus = (typeof GATE_CLIENT_STATUSES)[number];

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

export type PublicGateClient = Omit<GateClientDto, "secret_hash">;

export interface GateClientCreateInput {
  client_id: string;
  name: string;
  secret_hash: string;
  status?: GateClientStatus;
  created_by?: number | null;
  updated_by?: number | null;
}

export interface GateClientUpdateInput {
  name?: string;
  status?: GateClientStatus;
  updated_by?: number | null;
}
