// Mock ของ src/config/spaces.ts สำหรับ route test — แทนที่ S3Client จริงทั้งหมด ไม่มีการยิง network
// ออกไปหา DigitalOcean Spaces เลย (แนวทางเดียวกับ notificationQueueMock ใน
// app-test-notification-mocks.ts) เก็บ URL ที่ "อัปโหลด"/"ลบ" ไว้ใน memory ให้ test อื่นตรวจสอบได้

const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

let uploadCounter = 0;

export const spacesMockState = {
  uploadedUrls: [] as string[],
  deletedUrls: [] as string[],
};

export function resetSpacesMockState(): void {
  uploadCounter = 0;
  spacesMockState.uploadedUrls.length = 0;
  spacesMockState.deletedUrls.length = 0;
}

export const spacesMock = {
  uploadAdminProfileImage: async (
    _buffer: Buffer,
    mimeType: string
  ): Promise<string> => {
    uploadCounter += 1;
    const extension = EXTENSION_BY_MIME_TYPE[mimeType] ?? ".bin";
    const url = `https://test-admin-uploads.sgp1.digitaloceanspaces.com/admins/test-${uploadCounter}${extension}`;

    spacesMockState.uploadedUrls.push(url);
    return url;
  },
  deleteAdminProfileImageByUrl: async (url: string): Promise<void> => {
    spacesMockState.deletedUrls.push(url);
  },
};
