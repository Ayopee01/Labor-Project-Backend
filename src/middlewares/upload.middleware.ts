// Import Library
import multer from "multer";
// Import Utils
import ApiError from "../utils/api-error";

/* -------------------------------------- Config -------------------------------------- */

// Config ของ MIME types ของรูปภาพที่อนุญาตให้ upload
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

// Export object จัดการ upload รูปภาพสำหรับ admin (ใช้ memory storage และจำกัดขนาดไฟล์ไม่เกิน 5MB)
export const uploadAdminImage = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (_req, file, callback) => {
    if (!allowedImageMimeTypes.has(file.mimetype)) {
      callback(
        new ApiError(
          400,
          "INVALID_IMAGE_TYPE",
          "Only jpg, png, and webp images are allowed."
        )
      );
      return;
    }

    callback(null, true);
  },
});

/* -------------------------------------- Functions -------------------------------------- */

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

