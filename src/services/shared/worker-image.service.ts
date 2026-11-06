// Import Library
import { createHash } from "crypto";
// Import Config
import { deleteWorkerProfileImageByUrl, isSpacesConfigured, stripImageVersion, uploadWorkerProfileImage } from "../../config/spaces";
// Import Repositories
import * as workerImageRepository from "../../repositories/shared/worker-image.repository";
// Import Types
import type { WorkerImageSyncResult, WorkerImageSyncSummary, WorkerImageType } from "../../types/shared/worker-image.type";
// Import Utils
import { logger } from "../../utils/logger";

/* -------------------------------------- Functions -------------------------------------- */

// Function คำนวณ SHA-256 ของรูปต้นฉบับ (hex 64 ตัว) ใช้ดูว่ารูปเปลี่ยนหรือไม่
export function hashWorkerPicture(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Function ตรวจชนิดไฟล์รูปจากไบต์แรกของไฟล์ (JPEG / PNG / WebP) คืน null ถ้าไม่ใช่รูปที่รองรับ
export function detectWorkerImageType(bytes: Uint8Array): WorkerImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime_type: "image/jpeg", extension: ".jpg" };
  }

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return { mime_type: "image/png", extension: ".png" };
  }

  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  ) {
    return { mime_type: "image/webp", extension: ".webp" };
  }

  return null;
}

// Function อัปโหลดรูปต้นฉบับของ worker ขึ้น Spaces เมื่อรูปเปลี่ยน แล้วบันทึก image_url + picture_hash
export async function syncWorkerImage(workerId: number): Promise<WorkerImageSyncResult> {
  const record = await workerImageRepository.findWorkerPicture(workerId);

  if (!record) {
    return "not_found";
  }

  if (!record.picture || record.picture.length === 0) {
    return "no_picture";
  }

  const pictureHash = hashWorkerPicture(record.picture);

  if (record.picture_hash === pictureHash && record.image_url) {
    return "unchanged";
  }

  const imageType = detectWorkerImageType(record.picture);

  if (!imageType) {
    logger.warn("Worker picture is not a supported image type; skipped upload.", { workerId });
    return "unsupported_type";
  }

  // ชื่อไฟล์ = WorkerCode ทับไฟล์เดิม ส่วน URL มี ?v=hash ให้ browser โหลดรูปใหม่
  const imageUrl = await uploadWorkerProfileImage(
    record.labor_code,
    imageType.extension,
    Buffer.from(record.picture),
    imageType.mime_type,
  );
  const saved = await workerImageRepository.saveWorkerImage(record.id, record.updated_at, {
    image_url: imageUrl,
    picture_hash: pictureHash,
  });

  // แถวถูกแก้ระหว่างอัปโหลด (เช่นรูปใหม่เข้ามา) ไม่บันทึกทับ รอบถัดไปจะอัปโหลดรูปล่าสุดเอง
  if (!saved) {
    return "changed_during_sync";
  }

  // ไฟล์เดิมคนละชื่อกับไฟล์ใหม่ (เช่นเปลี่ยนชนิดรูป) ลบแบบ best-effort ลบไม่สำเร็จก็ไม่กระทบ image_url ใหม่
  if (record.image_url && stripImageVersion(record.image_url) !== stripImageVersion(imageUrl)) {
    try {
      await deleteWorkerProfileImageByUrl(record.image_url);
    } catch (error) {
      logger.warn("Failed to delete previous worker image from Spaces.", { workerId, error });
    }
  }

  return "uploaded";
}

// Function อัปโหลดรูปของ worker ตาม id ที่ระบุทีละคน (รูปที่ hash ตรงกับที่อัปโหลดแล้วจะถูกข้าม)
export async function syncWorkerImages(workerIds: number[]): Promise<WorkerImageSyncSummary> {
  const summary: WorkerImageSyncSummary = {
    spaces_configured: isSpacesConfigured(),
    total: workerIds.length,
    uploaded: 0,
    unchanged: 0,
    unsupported_type: 0,
    changed_during_sync: 0,
    failed: 0,
  };

  // ยังไม่ได้ตั้งค่า Spaces: ข้ามทั้งหมด รูปต้นฉบับยังอยู่ใน DB รอรอบที่ตั้งค่าแล้ว
  if (!summary.spaces_configured) {
    return summary;
  }

  for (const workerId of workerIds) {
    try {
      const result = await syncWorkerImage(workerId);

      if (result === "uploaded" || result === "unchanged" || result === "unsupported_type" || result === "changed_during_sync") {
        summary[result] += 1;
      }
    } catch (error) {
      summary.failed += 1;
      logger.error("Failed to sync worker image to Spaces.", { workerId, error });
    }
  }

  return summary;
}

// Function อัปโหลดรูปของ worker ทุกคนที่ยังไม่ได้อัปโหลดรูปปัจจุบัน (รันซ้ำได้ ไม่อัปโหลดรูปเดิมซ้ำ)
export async function syncPendingWorkerImages(): Promise<WorkerImageSyncSummary> {
  return syncWorkerImages(await workerImageRepository.listWorkerIdsPendingImageSync());
}

// Function ตรวจรูปของ worker ทุกคนที่มีรูปต้นฉบับแบบเทียบ hash (จับรูปที่เปลี่ยนแต่ picture_hash ไม่ถูกล้าง)
export async function syncAllWorkerImages(): Promise<WorkerImageSyncSummary> {
  return syncWorkerImages(await workerImageRepository.listWorkerIdsWithPicture());
}
