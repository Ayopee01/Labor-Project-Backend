// Import Repositories
import { client, toId } from "./repository-utils";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";
import type { WorkerPictureRecord } from "../../types/shared/worker-image.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function ดึงรูปต้นฉบับของ worker พร้อม hash และ URL ปัจจุบันจาก DB
export async function findWorkerPicture(
  workerId: number | string,
  connection?: DbConnection,
): Promise<WorkerPictureRecord | null> {
  const db = client(connection);
  const record = await db.masterWorker.findUnique({
    where: {
      id: toId(workerId),
    },
    select: {
      id: true,
      laborCode: true,
      picture: true,
      pictureHash: true,
      imageUrl: true,
      updatedAt: true,
    },
  });

  if (!record) {
    return null;
  }

  return {
    id: record.id,
    labor_code: record.laborCode,
    picture: record.picture,
    picture_hash: record.pictureHash,
    image_url: record.imageUrl,
    updated_at: record.updatedAt,
  };
}

// Function ดึง id ของ worker ที่มีรูปแต่ยังไม่ได้อัปโหลดรูปปัจจุบันขึ้น Spaces
export async function listWorkerIdsPendingImageSync(
  connection?: DbConnection,
): Promise<number[]> {
  const db = client(connection);
  const records = await db.masterWorker.findMany({
    where: {
      picture: { not: null },
      OR: [{ pictureHash: null }, { imageUrl: null }],
    },
    select: {
      id: true,
    },
    orderBy: {
      id: "asc",
    },
  });

  return records.map((record) => record.id);
}

// Function ดึง id ของ worker ทุกคนที่มีรูปต้นฉบับ (ใช้ตรวจ/อัปโหลดทั้งหมดแบบเทียบ hash)
export async function listWorkerIdsWithPicture(
  connection?: DbConnection,
): Promise<number[]> {
  const db = client(connection);
  const records = await db.masterWorker.findMany({
    where: {
      picture: { not: null },
    },
    select: {
      id: true,
    },
    orderBy: {
      id: "asc",
    },
  });

  return records.map((record) => record.id);
}

// Function ดึง WorkerCode ของ worker ที่ไม่มีรูปต้นฉบับใน DB
export async function listWorkerCodesWithoutPicture(
  connection?: DbConnection,
): Promise<string[]> {
  const db = client(connection);
  const records = await db.masterWorker.findMany({
    where: {
      picture: null,
    },
    select: {
      laborCode: true,
    },
    orderBy: {
      laborCode: "asc",
    },
  });

  return records.map((record) => record.laborCode);
}

// Function ดึงบัญชี Admin พร้อม URL รูปโปรไฟล์ปัจจุบัน
export async function listAdminImages(
  connection?: DbConnection,
): Promise<Array<{ id: number; image_url: string | null }>> {
  const db = client(connection);
  const records = await db.account.findMany({
    select: {
      id: true,
      imageUrl: true,
    },
    orderBy: {
      id: "asc",
    },
  });

  return records.map((record) => ({ id: record.id, image_url: record.imageUrl }));
}

// Function บันทึก URL และ hash ของรูปที่อัปโหลดแล้ว เฉพาะเมื่อแถวไม่ถูกแก้ระหว่างอัปโหลด (คืน false ถ้ามีคนแก้ก่อน)
export async function saveWorkerImage(
  workerId: number,
  readAt: Date,
  image: { image_url: string; picture_hash: string },
  connection?: DbConnection,
): Promise<boolean> {
  const db = client(connection);
  const result = await db.masterWorker.updateMany({
    where: {
      id: workerId,
      updatedAt: readAt,
    },
    data: {
      imageUrl: image.image_url,
      pictureHash: image.picture_hash,
    },
  });

  return result.count === 1;
}
