// Import Library
import { Prisma, type MasterProduct, type MasterRate } from "@prisma/client";
// Import Config
import { MASTER_OWNER_STALL_ACTIVE_STATUS } from "../../constants/status";
// Import Repositories
import { client } from "./repository-utils";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function ค้นหา master_product ที่ยังใช้งานอยู่จาก productCode + packageCode
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

// Function ดึงแพ็กเกจที่ยังใช้งานอยู่ทั้งหมดของ productCode (ให้ Worker เลือกเปลี่ยน PackageCode)
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

// Function ค้นหาเจ้าของแผง (MasterOwnerStall) แบบ batch ตาม marketCode + boothCode (แผงเดียวมีได้หลายเจ้าของ แยกตามเลขบัตร และแต่ละคนมีได้หลาย LINE)
export async function findOwnerStallsByMarketAndBooth(
  pairs: Array<{ marketCode: string; boothCode: string }>,
  connection?: DbConnection
): Promise<
  Map<
    string,
    Array<{ full_name: string | null; card_id: string; line_user_ids: string[] }>
  >
> {
  const map = new Map<
    string,
    Array<{ full_name: string | null; card_id: string; line_user_ids: string[] }>
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
    orderBy: {
      id: "asc",
    },
  });

  for (const ownerStall of ownerStalls) {
    const key = `${ownerStall.marketCode}::${ownerStall.boothCode}`;
    const owners = map.get(key) ?? [];
    let owner = owners.find((item) => item.card_id === ownerStall.cardId);

    if (!owner) {
      owner = {
        full_name: buildOwnerFullName(ownerStall.firstName, ownerStall.lastName),
        card_id: ownerStall.cardId,
        line_user_ids: [],
      };
      owners.push(owner);
    }

    if (ownerStall.lineUserId && !owner.line_user_ids.includes(ownerStall.lineUserId)) {
      owner.line_user_ids.push(ownerStall.lineUserId);
    }

    map.set(key, owners);
  }

  return map;
}

// Function ค้นหาชื่อสมาชิกแผง (MasterMemberStall) แบบ batch ตามเลขบัตรเจ้าของ + LINE user id ของสมาชิก
export async function findMemberStallFullNamesByOwnerCardAndLineUserId(
  requests: Array<{
    marketCode: string;
    ownerCardId: string;
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
        memberStallLineUserId: request.memberLineUserId,
      })),
    },
    orderBy: {
      id: "asc",
    },
  });

  for (const member of members) {
    const key = `${member.marketCode}::${member.ownerIdCard}::${member.memberStallLineUserId}`;

    if (!map.has(key)) {
      map.set(key, buildOwnerFullName(member.memberStallFirstName, member.memberStallLastName));
    }
  }

  return map;
}

// Function ดึงเจ้าของแผงที่ active และมี LINE ทั้งระบบ หรือเฉพาะแผงที่ระบุ
export async function listActiveOwnerStallLinks(
  booths: Array<{ marketCode: string; boothCode: string }> | null,
  connection?: DbConnection
): Promise<Array<{ marketCode: string; boothCode: string; cardId: string }>> {
  const db = client(connection);
  return db.masterOwnerStall.findMany({
    where: {
      status: MASTER_OWNER_STALL_ACTIVE_STATUS,
      lineUserId: { not: null },
      ...(booths
        ? {
            OR: booths.map((booth) => ({
              marketCode: booth.marketCode,
              boothCode: booth.boothCode,
            })),
          }
        : {}),
    },
    select: {
      marketCode: true,
      boothCode: true,
      cardId: true,
    },
    orderBy: {
      id: "asc",
    },
  });
}

// Function ดึงคู่ marketCode + ownerIdCard ที่มี LINE user id นี้เป็นลูกแผงอยู่แล้ว
export async function listMemberStallOwnersByLineUserId(
  memberStallLineUserId: string,
  owners: Array<{ marketCode: string; cardId: string }>,
  connection?: DbConnection
): Promise<Array<{ marketCode: string; ownerIdCard: string }>> {
  if (owners.length === 0) {
    return [];
  }

  const db = client(connection);

  return db.masterMemberStall.findMany({
    where: {
      memberStallLineUserId,
      OR: owners.map((owner) => ({
        marketCode: owner.marketCode,
        ownerIdCard: owner.cardId,
      })),
    },
    select: {
      marketCode: true,
      ownerIdCard: true,
    },
    distinct: ["marketCode", "ownerIdCard"],
  });
}

// Function เพิ่ม test member stall ให้เจ้าของแผงที่ระบุ (ใช้กับหน้า LINE dev tester)
export async function createTestMemberStalls(
  member: {
    memberStallLineUserId: string;
    memberStallFirstName?: string | null;
    memberStallLastName?: string | null;
  },
  owners: Array<{ marketCode: string; cardId: string }>,
  connection?: DbConnection
): Promise<number> {
  const db = client(connection);
  const result = await db.masterMemberStall.createMany({
    data: owners.map((owner) => ({
      marketCode: owner.marketCode,
      ownerIdCard: owner.cardId,
      memberStallLineUserId: member.memberStallLineUserId,
      memberStallFirstName: member.memberStallFirstName ?? null,
      memberStallLastName: member.memberStallLastName ?? null,
      status: MASTER_OWNER_STALL_ACTIVE_STATUS,
    })),
    skipDuplicates: true,
  });

  return result.count;
}
