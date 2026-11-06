// Import Library
import crypto from "crypto";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
// Import Middlewares
import { imageExtensionByMimeType } from "../middlewares/upload.middleware";
// Import Utils
import ApiError from "../utils/api-error";

/* -------------------------------------- Config -------------------------------------- */

// Config S3 client ที่สร้างครั้งเดียวแล้วใช้ซ้ำ
let client: S3Client | null = null;

/* -------------------------------------- Functions -------------------------------------- */

// Function อ่านค่า Spaces จาก env (คืน null ถ้าตั้งค่าไม่ครบ)
function readSpacesConfig() {
  const endpoint = process.env.SPACES_ENDPOINT;
  const region = process.env.SPACES_REGION;
  const accessKeyId = process.env.SPACES_ACCESS_KEY;
  const secretAccessKey = process.env.SPACES_SECRET_KEY;
  const bucket = process.env.SPACES_BUCKET;

  if (!endpoint || !region || !accessKeyId || !secretAccessKey || !bucket) {
    return null;
  }

  return { endpoint, region, accessKeyId, secretAccessKey, bucket };
}

// Function ตรวจว่าตั้งค่า Spaces ใน env ครบหรือยัง (ยังไม่ครบ = ข้ามการอัปโหลดรูป Worker ไปก่อน)
export function isSpacesConfigured(): boolean {
  return readSpacesConfig() !== null;
}

// Function อ่านค่า config ของ DigitalOcean Spaces จาก env — ถ้า env ไม่ครบให้ throw ApiError 503
function getSpacesConfig() {
  const config = readSpacesConfig();

  if (!config) {
    throw new ApiError(
      503,
      "SPACES_NOT_CONFIGURED",
      "Object storage is not configured."
    );
  }

  return config;
}

// Function create S3Client แบบ lazy เพื่อไม่ให้ import module นี้พังตอนที่ SPACES_* ยังไม่ถูกตั้งค่า
function getClient(config: ReturnType<typeof getSpacesConfig>): S3Client {
  if (!client) {
    client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  return client;
}

// Function สร้าง public URL ของไฟล์ใน Spaces
function buildPublicUrl(config: ReturnType<typeof getSpacesConfig>, folder: string, key: string): string {
  const host = config.endpoint.replace(/^https?:\/\//, "");

  return `https://${config.bucket}.${host}/${folder}/${key}`;
}

// Function ตัด query string (?v=...) ออกจาก URL ของรูป ใช้เทียบว่าเป็นไฟล์เดียวกันบน Spaces หรือไม่
export function stripImageVersion(url: string): string {
  return url.split("?")[0];
}

// Function extract key ของรูปจาก public URL ของ Spaces — ถ้าไม่ใช่ URL ของ Spaces ให้คืน null
function extractKeyFromUrl(folder: string, url: string): string | null {
  const bucket = process.env.SPACES_BUCKET ?? "";
  const host = (process.env.SPACES_ENDPOINT ?? "").replace(/^https?:\/\//, "");
  const prefix = `https://${bucket}.${host}/${folder}/`;
  const path = stripImageVersion(url);

  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

// Function upload รูปขึ้น DigitalOcean Spaces (ทับไฟล์ชื่อเดิม) — คืน URL พร้อม ?v=hash เพื่อไม่ติด cache รูปเก่า
async function putImage(
  folder: string,
  key: string,
  buffer: Buffer,
  mimeType: string
): Promise<string> {
  const config = getSpacesConfig();

  await getClient(config).send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: `${folder}/${key}`,
      Body: buffer,
      ContentType: mimeType,
      ACL: "public-read",
    })
  );

  const version = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 8);

  return `${buildPublicUrl(config, folder, key)}?v=${version}`;
}

// Function ลบรูปใน Spaces จาก public URL ของ folder ที่ระบุ (ไม่ใช่ URL ของ Spaces = ไม่ทำอะไร)
async function deleteImageByUrl(folder: string, url: string): Promise<void> {
  const key = extractKeyFromUrl(folder, url);

  if (!key) {
    return;
  }

  const config = getSpacesConfig();

  await getClient(config).send(
    new DeleteObjectCommand({
      Bucket: config.bucket,
      Key: `${folder}/${key}`,
    })
  );
}

// Function upload รูปโปรไฟล์ Admin ขึ้น Spaces ชื่อไฟล์ = AdminCode (folder admin-images)
export async function uploadAdminProfileImage(
  adminCode: string,
  buffer: Buffer,
  mimeType: string
): Promise<string> {
  const extension = imageExtensionByMimeType[mimeType] ?? ".bin";

  return putImage("admin-images", `${adminCode}${extension}`, buffer, mimeType);
}

// Function ลบรูปโปรไฟล์ Admin ใน Spaces จาก public URL (folder admin-images)
export async function deleteAdminProfileImageByUrl(url: string): Promise<void> {
  await deleteImageByUrl("admin-images", url);
}

// Function อัปโหลดรูปโปรไฟล์ Worker ขึ้น Spaces ชื่อไฟล์ = WorkerCode (folder worker-images)
export async function uploadWorkerProfileImage(
  laborCode: string,
  extension: string,
  buffer: Buffer,
  mimeType: string
): Promise<string> {
  return putImage("worker-images", `${laborCode}${extension}`, buffer, mimeType);
}

// Function ลบรูปโปรไฟล์ Worker ใน Spaces จาก public URL (folder worker-images)
export async function deleteWorkerProfileImageByUrl(url: string): Promise<void> {
  await deleteImageByUrl("worker-images", url);
}
