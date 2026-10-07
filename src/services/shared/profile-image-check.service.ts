// Import Config
import { isSpacesConfigured, stripImageVersion } from "../../config/spaces";
// Import Repositories
import * as workerImageRepository from "../../repositories/shared/worker-image.repository";
// Import Services
import { hashWorkerPicture } from "./worker-image.service";
// Import Types
import type { ProfileImageCheckReport } from "../../types/shared/worker-image.type";
// Import Utils
import { buildAdminEmployeeCode } from "../../utils/admin-code";

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจว่าไฟล์รูปยังอยู่บน Spaces จริง (HEAD ไปที่ URL ไม่รวม ?v=)
async function imageExists(url: string): Promise<boolean> {
  try {
    const response = await fetch(stripImageVersion(url), { method: "HEAD" });

    return response.ok;
  } catch {
    return false;
  }
}

// Function ตรวจรูปโปรไฟล์ของ Worker และ Admin ว่าครบหรือขาดตัวไหน (อ่านอย่างเดียว ไม่แก้ข้อมูล)
export async function checkProfileImages(options: { verify: boolean }): Promise<ProfileImageCheckReport> {
  const report: ProfileImageCheckReport = {
    spaces_configured: isSpacesConfigured(),
    verified_in_spaces: options.verify,
    worker: {
      total: 0,
      synced: 0,
      without_picture: await workerImageRepository.listWorkerCodesWithoutPicture(),
      pending_upload: [],
      missing_in_spaces: [],
    },
    admin: {
      total: 0,
      with_image: 0,
      without_image: [],
      missing_in_spaces: [],
    },
  };

  // Worker: เทียบ hash ของรูปต้นฉบับกับรูปที่อัปโหลดแล้วทีละคน
  for (const workerId of await workerImageRepository.listWorkerIdsWithPicture()) {
    const record = await workerImageRepository.findWorkerPicture(workerId);

    if (!record?.picture) {
      continue;
    }

    const isSynced = Boolean(record.image_url) && record.picture_hash === hashWorkerPicture(record.picture);

    if (!isSynced || !record.image_url) {
      report.worker.pending_upload.push(record.labor_code);
      continue;
    }

    report.worker.synced += 1;

    if (options.verify && !(await imageExists(record.image_url))) {
      report.worker.missing_in_spaces.push(record.labor_code);
    }
  }

  report.worker.total =
    report.worker.without_picture.length + report.worker.pending_upload.length + report.worker.synced;

  // Admin: อัปโหลดผ่าน API โดยตรง ไม่มีรูปต้นฉบับใน DB ตรวจแค่ว่ามีรูปและไฟล์ยังอยู่
  const admins = await workerImageRepository.listAdminImages();

  report.admin.total = admins.length;

  for (const admin of admins) {
    const adminCode = buildAdminEmployeeCode(admin.id);

    if (!admin.image_url) {
      report.admin.without_image.push(adminCode);
      continue;
    }

    report.admin.with_image += 1;

    if (options.verify && !(await imageExists(admin.image_url))) {
      report.admin.missing_in_spaces.push(adminCode);
    }
  }

  return report;
}

// Function ตรวจว่ารายงานมีรูป Worker ที่ยังต้องอัปโหลดหรือไฟล์หายจาก Spaces หรือไม่
export function hasProfileImageProblems(report: ProfileImageCheckReport): boolean {
  return (
    report.worker.pending_upload.length > 0 ||
    report.worker.missing_in_spaces.length > 0 ||
    report.admin.missing_in_spaces.length > 0
  );
}
