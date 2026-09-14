// Import Repositories
import * as gateClientRepository from "../../repositories/shared/gate-client.repository";
// Import Utils
import { verifyPassword } from "../../utils/password";
// Import Types
import type { GateClientDto, PublicGateClient } from "../../types/shared/gate-client.type";

/* -------------------------------------- Functions -------------------------------------- */

function toPublicGateClient(client: GateClientDto): PublicGateClient {
  const { secret_hash: _secretHash, ...publicClient } = client;

  return publicClient;
}

// Function ตรวจสอบ client_id/secret ของ gate client แล้วอัปเดตเวลาใช้งานล่าสุดถ้าถูกต้อง
export async function verifyGateClientCredentials(
  clientId: string,
  clientSecret: string
): Promise<PublicGateClient | null> {
  const client = await gateClientRepository.findByClientId(clientId);

  if (!client || client.status !== "active") {
    return null;
  }

  if (!(await verifyPassword(clientSecret, client.secret_hash))) {
    return null;
  }

  await gateClientRepository.updateLastUsedAt(client.client_id);

  return toPublicGateClient({
    ...client,
    last_used_at: new Date().toISOString(),
  });
}
