// Import Library
import { Prisma, type MasterProduct, type MasterRate } from "@prisma/client";
// Import Utils
import { client } from "./repository-utils";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function ค้นหา master_product ที่ยังใช้งานอยู่จาก productCode + packageCode
// ใช้ทั้งตอน Gate สร้าง Ticket และตอน Worker เปลี่ยน PackageCode ระหว่างส่งยอด
export async function listActiveProductsByProductCodeAndPackageCode(
  productCode: string,
  packageCode: string,
  connection?: DbConnection
): Promise<MasterProduct[]> {
  const db = client(connection);

  return db.masterProduct.findMany({
    where: {
      productCode,
      packageCode,
      status: "ACTIVE",
    },
    orderBy: {
      id: "asc",
    },
  });
}

// Function ค้นหา master_product จาก packageCode สำหรับ Package Fallback
export async function listActiveProductsByPackageCode(
  packageCode: string,
  connection?: DbConnection
): Promise<MasterProduct[]> {
  const db = client(connection);

  return db.masterProduct.findMany({
    where: {
      packageCode,
      status: "ACTIVE",
    },
    orderBy: {
      id: "asc",
    },
  });
}

// Function ค้นหา master_rate ที่ตรง market และช่วงน้ำหนักที่ยังใช้งานอยู่
export async function listActiveRatesByMarketAndWeight(
  marketCode: string,
  packageWeight: Prisma.Decimal,
  connection?: DbConnection
): Promise<MasterRate[]> {
  const db = client(connection);

  return db.masterRate.findMany({
    where: {
      marketCode,
      status: 1,
      weightMin: {
        lt: packageWeight,
      },
      weightMax: {
        gte: packageWeight,
      },
    },
    orderBy: {
      id: "asc",
    },
  });
}

// Function ค้นหาแพ็กเกจที่ยังใช้งานอยู่ทั้งหมดของ productCode เดียว
// ใช้โดย Worker ตอนเลือก PackageCode ใหม่ให้ Product เดิมในแผงที่กำลังส่งยอด
export async function listActiveMasterProductPackagesByProductCode(
  productCode: string,
  connection?: DbConnection
) {
  const db = client(connection);

  return db.masterProduct.findMany({
    where: {
      productCode,
      status: "ACTIVE",
    },
    select: {
      productCode: true,
      productName: true,
      packageCode: true,
      packageName: true,
      packageWeight: true,
    },
    orderBy: {
      packageCode: "asc",
    },
  });
}

// Function ประกอบชื่อเต็มจาก firstName + lastName สำหรับ Master Owner/Member Stall
function buildOwnerFullName(
  firstName: string | null,
  lastName: string | null
): string | null {
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();

  return fullName.length > 0 ? fullName : null;
}

// Function ค้นหา MasterOwnerStall แบบ batch ตาม marketCode + boothCode หลายคู่พร้อมกัน ใช้โดย
// Work History สำหรับ correction_owner และเป็นจุดเริ่มต้นของการ resolve ผู้กด Reject ผ่าน LINE
export async function findOwnerStallsByMarketAndBooth(
  pairs: Array<{ marketCode: string; boothCode: string }>,
  connection?: DbConnection
): Promise<
  Map<
    string,
    { full_name: string | null; card_id: string; line_user_id: string | null }
  >
> {
  const map = new Map<
    string,
    { full_name: string | null; card_id: string; line_user_id: string | null }
  >();

  if (pairs.length === 0) {
    return map;
  }

  const db = client(connection);
  const ownerStalls = await db.masterOwnerStall.findMany({
    where: {
      OR: pairs.map((pair) => ({
        marketCode: pair.marketCode,
        boothCode: pair.boothCode,
      })),
    },
  });

  for (const ownerStall of ownerStalls) {
    map.set(`${ownerStall.marketCode}::${ownerStall.boothCode}`, {
      full_name: buildOwnerFullName(ownerStall.firstName, ownerStall.lastName),
      card_id: ownerStall.cardId,
      line_user_id: ownerStall.lineUserId,
    });
  }

  return map;
}

// Function ค้นหาชื่อเต็มของ MasterMemberStall แบบ batch ตาม owner + memberLineUserId หลายคู่
// scope ด้วย marketCode+ownerIdCard+ownerLineUserId เหมือนกันเพื่อป้องกัน LINE ID ชนกันข้าม owner
export async function findMemberStallFullNamesByOwnerAndLineUserId(
  requests: Array<{
    marketCode: string;
    ownerCardId: string;
    ownerLineUserId: string;
    memberLineUserId: string;
  }>,
  connection?: DbConnection
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();

  if (requests.length === 0) {
    return map;
  }

  const db = client(connection);
  const members = await db.masterMemberStall.findMany({
    where: {
      OR: requests.map((request) => ({
        marketCode: request.marketCode,
        ownerIdCard: request.ownerCardId,
        ownerLineUserId: request.ownerLineUserId,
        memberStallLineUserId: request.memberLineUserId,
      })),
    },
  });

  for (const member of members) {
    map.set(
      `${member.marketCode}::${member.ownerIdCard}::${member.ownerLineUserId}::${member.memberStallLineUserId}`,
      buildOwnerFullName(member.memberStallFirstName, member.memberStallLastName)
    );
  }

  return map;
}
