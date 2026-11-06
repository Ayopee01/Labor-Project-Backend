// Import Types
import type { AppMiddleware } from "../types/shared/http.type";
// Import Utils
import ApiError from "../utils/api-error";

/* -------------------------------------- Config -------------------------------------- */

// Config MIME type ของรูปที่อนุญาตให้อัปโหลด
const allowedImageMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

// Export object คงที่ ใช้แปลง MIME type 
export const imageExtensionByMimeType: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

// Config ขนาดไฟล์รูปสูงสุด (5MB) และส่วนเผื่อ multipart boundary ของทั้ง request
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/* -------------------------------------- Functions -------------------------------------- */

// Function สร้าง error เมื่อไฟล์ใหญ่เกินเพดาน
function imageTooLargeError(): ApiError {
  return new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body is too large.");
}

// Function อ่านฟอร์ม multipart (ฟอร์มผิดรูปแบบตอบ 400)
async function readMultipartForm(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    throw new ApiError(400, "INVALID_REQUEST_BODY", "Request body could not be read.");
  }
}

// Function อ่านรูปจาก field "file" ของ multipart ลง context (ไม่มีไฟล์ปล่อยให้ route ตอบ error เอง)
export const uploadAdminImage: AppMiddleware = async (c, next) => {
  if (!c.req.header("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
    await next();
    return;
  }

  if (Number(c.req.header("content-length") ?? 0) > MAX_IMAGE_BYTES + MULTIPART_OVERHEAD_BYTES) {
    throw imageTooLargeError();
  }

  const file = (await readMultipartForm(c.req.raw)).get("file");

  if (file instanceof File) {
    if (!allowedImageMimeTypes.has(file.type)) {
      throw new ApiError(400, "INVALID_IMAGE_TYPE", "Only jpg, png, and webp images are allowed.");
    }

    if (file.size > MAX_IMAGE_BYTES) {
      throw imageTooLargeError();
    }

    c.set("file", { buffer: Buffer.from(await file.arrayBuffer()), mimetype: file.type });
  }

  await next();
};


// Function ตรวจสอบว่า buffer ของไฟล์ตรงกับ signature ของ MIME type หรือไม่ (เพื่อป้องกันการ spoofing ของไฟล์)
export function matchesImageSignature(buffer: Buffer, mimeType: string): boolean {
  // ตรวจสอบ signature ของไฟล์ตาม MIME type
  if (mimeType === "image/jpeg") {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  // ตรวจสอบ signature ของไฟล์ PNG และ WebP
  if (mimeType === "image/png") {
    const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return (
      buffer.length >= pngSignature.length &&
      pngSignature.every((byte, index) => buffer[index] === byte)
    );
  }
  // ตรวจสอบ signature ของไฟล์ WebP
  if (mimeType === "image/webp") {
    return (
      buffer.length >= 12 &&
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP"
    );
  }

  return false;
}

