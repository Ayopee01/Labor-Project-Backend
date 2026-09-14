import { PrismaClient } from "@prisma/client";

/* -------------------------------------- Mock Data -------------------------------------- */

// Mock data สำหรับ Version ของ Application สำหรับ Mobile App
const FIRST_VERSION_SEED = {
  version: "1.0.0",
  buildNumber: 1,
  androidDownloadUrl: "https://www.android.com/intl/th_th/",
  iosDownloadUrl: "https://www.apple.com/",
  releaseMessage: "First release.",
  releaseNotes: "Initial release of the app.",
} as const;

/* -------------------------------------- Functions -------------------------------------- */

// Function บันทึกข้อมูล Version ของ Application สำหรับ Mobile App
export async function seedMobileAppVersion(
  prisma: PrismaClient,
  adminId: number | null,
): Promise<void> {
  const now = new Date();

  await prisma.mobileAppVersion.upsert({
    where: {
      buildNumber: FIRST_VERSION_SEED.buildNumber,
    },
    update: {
      androidDownloadUrl: FIRST_VERSION_SEED.androidDownloadUrl,
      iosDownloadUrl: FIRST_VERSION_SEED.iosDownloadUrl,
    },
    create: {
      version: FIRST_VERSION_SEED.version,
      buildNumber: FIRST_VERSION_SEED.buildNumber,
      androidDownloadUrl: FIRST_VERSION_SEED.androidDownloadUrl,
      iosDownloadUrl: FIRST_VERSION_SEED.iosDownloadUrl,
      releaseMessage: FIRST_VERSION_SEED.releaseMessage,
      releaseNotes: FIRST_VERSION_SEED.releaseNotes,
      releaseNotificationSentAt: now,
      createdBy: adminId,
      updatedBy: adminId,
    },
  });

  console.log(
    `Seeded mobile_app_versions: ${FIRST_VERSION_SEED.version} (build ${FIRST_VERSION_SEED.buildNumber}).`,
  );
}
