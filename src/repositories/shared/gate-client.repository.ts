// Import Utils
import { client, requireMapped } from "./repository-utils";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";
import type { GateClientCreateInput, GateClientDto, GateClientUpdateInput } from "../../types/shared/gate-client.type";

/* -------------------------------------- Functions -------------------------------------- */

function toGateClientIsoString(value: Date | string | null): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
}

// Function แปลง GateClient record จาก DB เป็น DTO (normalize status ให้เป็น active/inactive เท่านั้น)
function mapGateClient(record: {
  id: number;
  clientId: string;
  name: string;
  secretHash: string;
  status: string;
  lastUsedAt: Date | null;
  createdBy: number | null;
  updatedBy: number | null;
  createdAt: Date;
  updatedAt: Date;
} | null): GateClientDto | null {
  if (!record) {
    return null;
  }

  return {
    id: record.id,
    client_id: record.clientId,
    name: record.name,
    secret_hash: record.secretHash,
    status: record.status === "inactive" ? "inactive" : "active",
    last_used_at: toGateClientIsoString(record.lastUsedAt),
    created_by: record.createdBy,
    updated_by: record.updatedBy,
    created_at: toGateClientIsoString(record.createdAt) as string,
    updated_at: toGateClientIsoString(record.updatedAt) as string,
  };
}

// Function ดึงรายการ gate client ทั้งหมดจาก DB
export async function listGateClients(
  connection?: DbConnection
): Promise<GateClientDto[]> {
  const records = await client(connection).gateClient.findMany({
    orderBy: {
      id: "asc",
    },
  });

  return records
    .map((record) => mapGateClient(record))
    .filter((record): record is GateClientDto => record !== null);
}

// Function ค้นหา gate client ตาม client_id จาก DB
export async function findByClientId(
  clientId: string,
  connection?: DbConnection
): Promise<GateClientDto | null> {
  const record = await client(connection).gateClient.findUnique({
    where: {
      clientId,
    },
  });

  return mapGateClient(record);
}

// Function ตรวจว่า client_id นี้มีอยู่ใน DB แล้วหรือไม่
export async function clientIdExists(
  clientId: string,
  connection?: DbConnection
): Promise<boolean> {
  const record = await client(connection).gateClient.findUnique({
    where: {
      clientId,
    },
    select: {
      id: true,
    },
  });

  return Boolean(record);
}

// Function สร้าง gate client ใหม่ลง DB
export async function createGateClient(
  input: GateClientCreateInput,
  connection?: DbConnection
): Promise<GateClientDto> {
  const record = await client(connection).gateClient.create({
    data: {
      clientId: input.client_id,
      name: input.name,
      secretHash: input.secret_hash,
      status: input.status ?? "active",
      createdBy: input.created_by ?? null,
      updatedBy: input.updated_by ?? null,
    },
  });

  return requireMapped(mapGateClient(record), "Gate client", "create");
}

// Function อัปเดตข้อมูล gate client (name/status) จาก DB
export async function updateGateClient(
  clientId: string,
  input: GateClientUpdateInput,
  connection?: DbConnection
): Promise<GateClientDto> {
  const record = await client(connection).gateClient.update({
    where: {
      clientId,
    },
    data: {
      name: input.name,
      status: input.status,
      updatedBy: input.updated_by ?? null,
    },
  });

  return requireMapped(mapGateClient(record), "Gate client", "update");
}

// Function อัปเดต secret hash ของ gate client จาก DB
export async function updateGateClientSecret(
  clientId: string,
  secretHash: string,
  updatedBy?: number | null,
  connection?: DbConnection
): Promise<GateClientDto> {
  const record = await client(connection).gateClient.update({
    where: {
      clientId,
    },
    data: {
      secretHash,
      updatedBy: updatedBy ?? null,
    },
  });

  return requireMapped(mapGateClient(record), "Gate client", "secret update");
}

// Function อัปเดตเวลาที่ gate client ถูกใช้งานล่าสุด
export async function updateLastUsedAt(
  clientId: string,
  connection?: DbConnection
): Promise<void> {
  await client(connection).gateClient.update({
    where: {
      clientId,
    },
    data: {
      lastUsedAt: new Date(),
    },
  });
}
