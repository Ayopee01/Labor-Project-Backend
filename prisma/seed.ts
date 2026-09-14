import dotenv from "dotenv";
import { closePrisma, getPrisma } from "../src/db/prisma";
import { ADMIN_PERMISSION_LEVELS, ADMIN_PERMISSIONS, OWNER_ONLY_PERMISSIONS } from "../src/config/permission.config";
import type { AdminPermission, AdminPermissionLevel } from "../src/config/permission.config";
import { hashPassword } from "../src/utils/password";

// Import seed functions
import { seedMasterMarkets } from "./master-market.seed";
import { seedMasterProducts } from "./master-product.seed";
import { seedMasterRates } from "./master-rate.seed";
import { seedMasterWorkers } from "./master-worker.seed";
import { seedLine } from "./line.seed";
import { seedMobileAppVersion } from "./version.seed";
import { seedRuntimeSettings } from "./runtime-settings.seed";

dotenv.config({ quiet: true });

const prisma = getPrisma();

/* -------------------------------------- Types -------------------------------------- */

type SeedAdminAccount = {
  username: string;
  password: string;
  fullName: string;
  position: string;
  email: string;
  phone: string;
};

/* -------------------------------------- Mock Data -------------------------------------- */

// Mock data สำหรับบัญชีผู้ดูแลระบบ (Admin) ของระบบ
const SEED_ADMIN_ACCOUNTS: Record<AdminPermissionLevel, SeedAdminAccount> = {
  owner: {
    username: "admin",
    password: "Admin@123456",
    fullName: "System Admin",
    position: "Administrator",
    email: "admin@simmummuang.local",
    phone: "081-000-0001",
  },
  manager: {
    username: "manager01",
    password: "Manager@123456",
    fullName: "Branch Manager",
    position: "Manager",
    email: "manager01@simmummuang.local",
    phone: "081-000-0002",
  },
  supervisor: {
    username: "supervisor01",
    password: "Supervisor@123456",
    fullName: "Operations Supervisor",
    position: "Supervisor",
    email: "supervisor01@simmummuang.local",
    phone: "081-000-0003",
  },
};

// Mock data สำหรับ Gate Client
const SEED_GATE_CLIENT = {
  clientId: "gate-main",
  name: "Main Gate Demo Client",
  secret: "gate_live_RnqzqVz1OCeLiEMMQRrddGDjaWxfDt2a7779bKJomTc",
};

// Permission templates สำหรับแต่ละระดับ permission ของ admin
const SEED_OPERATION_PERMISSIONS = ADMIN_PERMISSIONS.filter(
  (permission) =>
    permission !== "settings:update" && permission !== "permissions:update",
);

// manager มี permission กลุ่ม OWNER_ONLY_PERMISSIONS แค่ read เท่านั้น
const SEED_MANAGER_PERMISSIONS = ADMIN_PERMISSIONS.filter(
  (permission) =>
    permission === "mobile_app_versions:read" ||
    !(OWNER_ONLY_PERMISSIONS as readonly AdminPermission[]).includes(permission),
);

// supervisor ไม่ได้ permission กลุ่ม OWNER_ONLY_PERMISSIONS เลยแม้แต่ read
const SEED_SUPERVISOR_PERMISSIONS = SEED_OPERATION_PERMISSIONS.filter(
  (permission) =>
    !(OWNER_ONLY_PERMISSIONS as readonly AdminPermission[]).includes(permission),
);

// role permission templates สำหรับแต่ละระดับ permission ของ admin
const SEED_ROLE_PERMISSION_TEMPLATES: Record<
  AdminPermissionLevel,
  AdminPermission[]
> = {
  owner: [...ADMIN_PERMISSIONS],
  manager: [...SEED_MANAGER_PERMISSIONS],
  supervisor: [...SEED_SUPERVISOR_PERMISSIONS],
};

/* -------------------------------------- Functions -------------------------------------- */

// Function upsert บัญชีผู้ดูแลจาก seed โดยไม่เขียนทับ password เดิมเมื่อรัน seed ซ้ำ
async function upsertSeedAdminAccount(
  seedAccount: SeedAdminAccount,
  permissionLevel: AdminPermissionLevel,
  createdBy?: number,
) {
  return prisma.account.upsert({
    where: {
      username: seedAccount.username,
    },
    update: {
      role: "admin",
      status: "active",
      fullName: seedAccount.fullName,
      position: seedAccount.position,
      email: seedAccount.email,
      phone: seedAccount.phone,
      permissionLevel,
      ...(createdBy !== undefined ? { createdBy } : {}),
    },
    create: {
      username: seedAccount.username,
      passwordHash: await hashPassword(seedAccount.password),
      role: "admin",
      status: "active",
      fullName: seedAccount.fullName,
      position: seedAccount.position,
      email: seedAccount.email,
      phone: seedAccount.phone,
      permissionLevel,
      createdBy,
    },
  });
}

// Function สำหรับ run seed ทั้งหมด
async function main(): Promise<void> {
  const admin = await upsertSeedAdminAccount(SEED_ADMIN_ACCOUNTS.owner, "owner");
  const adminAccounts = [admin];

  for (const permissionLevel of ADMIN_PERMISSION_LEVELS) {
    if (permissionLevel === "owner") {
      continue;
    }

    adminAccounts.push(
      await upsertSeedAdminAccount(
        SEED_ADMIN_ACCOUNTS[permissionLevel],
        permissionLevel,
        admin.id,
      ),
    );
  }

  await seedRuntimeSettings(prisma, admin.id);

  await prisma.gateClient.upsert({
    where: {
      clientId: SEED_GATE_CLIENT.clientId,
    },
    update: {
      name: SEED_GATE_CLIENT.name,
      secretHash: await hashPassword(SEED_GATE_CLIENT.secret),
      status: "active",
      updatedBy: admin.id,
    },
    create: {
      clientId: SEED_GATE_CLIENT.clientId,
      name: SEED_GATE_CLIENT.name,
      secretHash: await hashPassword(SEED_GATE_CLIENT.secret),
      status: "active",
      createdBy: admin.id,
      updatedBy: admin.id,
    },
  });

  for (const account of adminAccounts) {
    const permissions =
      account.permissionLevel &&
      account.permissionLevel in SEED_ROLE_PERMISSION_TEMPLATES
        ? SEED_ROLE_PERMISSION_TEMPLATES[
            account.permissionLevel as AdminPermissionLevel
          ]
        : [];

    await prisma.accountPermission.deleteMany({
      where: {
        accountId: account.id,
      },
    });

    if (permissions.length > 0) {
      await prisma.accountPermission.createMany({
        data: permissions.map((permission) => ({
          accountId: account.id,
          permission,
        })),
        skipDuplicates: true,
      });
    }

    console.log(
      `Seed admin account ready: ${account.username} (${account.permissionLevel}, ${permissions.length} permissions)`,
    );
  }

  console.log("Seeding master markets...");
  await seedMasterMarkets(prisma);

  console.log("Seeding master products...");
  await seedMasterProducts(prisma);

  console.log("Seeding master rates...");
  await seedMasterRates(prisma);

  console.log("Seeding master workers...");
  await seedMasterWorkers(prisma);

  console.log("Seeding test LINE mapping...");
  await seedLine(prisma);

  console.log("Seeding mobile app version...");
  await seedMobileAppVersion(prisma, admin.id);

  console.log("All seeds completed.");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await closePrisma();
  });
