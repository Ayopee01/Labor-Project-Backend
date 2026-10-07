/* -------------------------------------- Types -------------------------------------- */

// Type รูปต้นฉบับของ worker พร้อมสถานะการอัปโหลดขึ้น Spaces
export interface WorkerPictureRecord {
  id: number;
  labor_code: string;
  picture: Uint8Array | null;
  picture_hash: string | null;
  image_url: string | null;
  updated_at: Date;
}

// Type ชนิดไฟล์รูปที่ตรวจจากไบต์แรกของไฟล์
export interface WorkerImageType {
  mime_type: string;
  extension: string;
}

// Type ผลการอัปโหลดรูปของ worker หนึ่งคน
export type WorkerImageSyncResult =
  | "uploaded"
  | "unchanged"
  | "no_picture"
  | "unsupported_type"
  | "changed_during_sync"
  | "not_found";

// Type สรุปผลการอัปโหลดรูปของ worker ทั้งชุด
export interface WorkerImageSyncSummary {
  // false = ยังไม่ได้ตั้งค่า Spaces ใน env จึงข้ามการอัปโหลดทั้งหมด
  spaces_configured: boolean;
  total: number;
  uploaded: number;
  unchanged: number;
  unsupported_type: number;
  changed_during_sync: number;
  failed: number;
}

// Type รายงานตรวจรูปโปรไฟล์ของ Worker และ Admin
export interface ProfileImageCheckReport {
  spaces_configured: boolean;
  // true = เช็คไฟล์บน Spaces จริงด้วย (ตัวเลือก --verify)
  verified_in_spaces: boolean;
  worker: {
    total: number;
    synced: number;
    // WorkerCode ที่ไม่มีรูปต้นฉบับใน DB
    without_picture: string[];
    // WorkerCode ที่มีรูปแต่ยังไม่ได้อัปโหลดรูปปัจจุบัน
    pending_upload: string[];
    // WorkerCode ที่บันทึก image_url แล้วแต่ไม่พบไฟล์บน Spaces
    missing_in_spaces: string[];
  };
  admin: {
    total: number;
    with_image: number;
    // AdminCode ที่ยังไม่มีรูปโปรไฟล์
    without_image: string[];
    // AdminCode ที่บันทึก image_url แล้วแต่ไม่พบไฟล์บน Spaces
    missing_in_spaces: string[];
  };
}
