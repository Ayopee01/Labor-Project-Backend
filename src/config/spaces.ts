import crypto from "crypto";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import ApiError from "../utils/api-error";
import { imageExtensionByMimeType } from "../middlewares/upload.middleware";

let client: S3Client | null = null;

/* -------------------------------------- Functions -------------------------------------- */

// Function อ่านค่า config ของ DigitalOcean Spaces จาก env — ถ้า env ไม่ครบให้ throw ApiError 503
function getSpacesConfig() {
  const endpoint = process.env.SPACES_ENDPOINT;
  const region = process.env.SPACES_REGION;
  const accessKeyId = process.env.SPACES_ACCESS_KEY;
  const secretAccessKey = process.env.SPACES_SECRET_KEY;
  const bucket = process.env.SPACES_ADMIN_BUCKET;

  if (!endpoint || !region || !accessKeyId || !secretAccessKey || !bucket) {
    throw new ApiError(
      503,
      "SPACES_NOT_CONFIGURED",
      "Object storage is not configured."
    );
  }

  return { endpoint, region, accessKeyId, secretAccessKey, bucket };
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

function buildPublicUrl(config: ReturnType<typeof getSpacesConfig>, folder: string, key: string): string {
  const host = config.endpoint.replace(/^https?:\/\//, "");

  return `https://${config.bucket}.${host}/${folder}/${key}`;
}

// Function extract key ของรูปจาก public URL ของ Spaces — ถ้าไม่ใช่ URL ของ Spaces ให้คืน null
function extractKeyFromUrl(folder: string, url: string): string | null {
  const bucket = process.env.SPACES_ADMIN_BUCKET ?? "";
  const host = (process.env.SPACES_ENDPOINT ?? "").replace(/^https?:\/\//, "");
  const prefix = `https://${bucket}.${host}/${folder}/`;

  return url.startsWith(prefix) ? url.slice(prefix.length) : null;
}

// Function upload รูปขึ้น DigitalOcean Spaces — คืน public URL ของรูปที่อัปโหลดแล้ว
async function putImage(
  config: ReturnType<typeof getSpacesConfig>,
  folder: string,
  key: string,
  buffer: Buffer,
  mimeType: string
): Promise<string> {
  await getClient(config).send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: `${folder}/${key}`,
      Body: buffer,
      ContentType: mimeType,
      ACL: "public-read",
    })
  );

  return buildPublicUrl(config, folder, key);
}

// Function upload รูปโปรไฟล์ Admin ขึ้น DigitalOcean Spaces — ใต้ folder "admin-images" 
export async function uploadAdminProfileImage(
  buffer: Buffer,
  mimeType: string
): Promise<string> {
  const config = getSpacesConfig();
  const extension = imageExtensionByMimeType[mimeType] ?? ".bin";
  const key = `${Date.now()}-${crypto.randomUUID()}${extension}`;

  return putImage(config, "admin-images", key, buffer, mimeType);
}

// Function delete รูปโปรไฟล์ Admin จาก DigitalOcean Spaces — ใต้ folder "admin-images" โดยใช้ public URL ของรูป
export async function deleteAdminProfileImageByUrl(url: string): Promise<void> {
  const key = extractKeyFromUrl("admin-images", url);

  if (!key) {
    return;
  }

  const config = getSpacesConfig();

  await getClient(config).send(
    new DeleteObjectCommand({
      Bucket: config.bucket,
      Key: `admin-images/${key}`,
    })
  );
}

// Function upload รูปโปรไฟล์ Worker ขึ้น DigitalOcean Spaces — ใต้ folder "worker-images" โดยใช้ laborCode เป็นชื่อไฟล์
export async function uploadWorkerProfileImage(
  laborCode: string,
  buffer: Buffer
): Promise<string> {
  const config = getSpacesConfig();

  return putImage(config, "worker-images", `${laborCode}.jpg`, buffer, "image/jpeg");
}
