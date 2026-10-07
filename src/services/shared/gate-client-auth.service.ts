// Import Repositories
import * as gateClientRepository from "../../repositories/shared/gate-client.repository";
// Import Types
import type { GateClientDto, PublicGateClient } from "../../types/shared/gate-client.type";
// Import Utils
import { hashPassword, verifyPassword } from "../../utils/password";

/* -------------------------------------- Config -------------------------------------- */

// Config hash หลอกให้ตรวจ secret ทุกครั้งแม้ไม่พบ client (เวลาตอบเท่ากัน เดา clientId ไม่ได้)
const dummySecretHashPromise = hashPassword("dummy-gate-secret-for-constant-time-check");

/* -------------------------------------- Functions -------------------------------------- */

// Function ตัด secret_hash ออกจาก Gate client ก่อนส่งออกนอก service (ใช้ร่วมกับ Admin Settings)
export function toPublicGateClient(client: GateClientDto): PublicGateClient {
  const { secret_hash: _secretHash, ...publicClient } = client;

  return publicClient;
}

// Function ตรวจสอบ client_id/secret ของ gate client แล้วอัปเดตเวลาใช้งานล่าสุดถ้าถูกต้อง
export async function verifyGateClientCredentials(
  clientId: string,
  clientSecret: string
): Promise<PublicGateClient | null> {
  const client = await gateClientRepository.findByClientId(clientId);
  const secretValid = await verifyPassword(
    clientSecret,
    client?.secret_hash ?? (await dummySecretHashPromise)
  );

  if (!client || client.status !== "active" || !secretValid) {
    return null;
  }

  await gateClientRepository.updateLastUsedAt(client.client_id);

  return toPublicGateClient({
    ...client,
    last_used_at: new Date().toISOString(),
  });
}
