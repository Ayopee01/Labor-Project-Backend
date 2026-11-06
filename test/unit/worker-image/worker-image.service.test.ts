// Import Library
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, test } from "node:test";
import Module = require("node:module");

/* -------------------------------------- Fakes -------------------------------------- */

// Config ไบต์ตัวอย่างของรูปแต่ละชนิด (แค่ส่วนหัวไฟล์ที่ใช้ตรวจชนิด)
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0xff, 0xd9]);
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const WEBP_BYTES = Uint8Array.from([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")]);

// Type แถวรูปของ worker ใน fake DB
type FakeWorkerRow = {
  id: number;
  labor_code: string;
  picture: Uint8Array | null;
  picture_hash: string | null;
  image_url: string | null;
  updated_at: Date;
};

// State ของ fake ที่แต่ละ test กำหนดข้อมูลและตรวจผลที่ service เขียนกลับ
const fake = {
  rows: new Map<number, FakeWorkerRow>(),
  uploads: [] as Array<{ key: string; mimeType: string }>,
  deletedUrls: [] as string[],
  // จำลองว่ามีคนแก้แถวระหว่างอัปโหลด
  touchDuringUpload: false,
  failUploadFor: new Set<string>(),
  spacesConfigured: true,
  admins: [] as Array<{ id: number; image_url: string | null }>,
};

// Type ส่วน signature ของ Module._load
type ModuleLoad = (request: string, parent: NodeModule | null | undefined, isMain: boolean) => unknown;
const moduleWithLoad = Module as typeof Module & { _load: ModuleLoad };
const originalLoad = moduleWithLoad._load;

// แทน Spaces และ repository ด้วย fake ก่อน require service
moduleWithLoad._load = function patchedLoad(request, parent, isMain) {
  if (request.endsWith("config/spaces")) {
    return {
      isSpacesConfigured: () => fake.spacesConfigured,
      stripImageVersion: (url: string) => url.split("?")[0],
      uploadWorkerProfileImage: async (laborCode: string, extension: string, buffer: Buffer, mimeType: string) => {
        if (fake.failUploadFor.has(laborCode)) {
          throw new Error("upload failed");
        }

        const key = `${laborCode}${extension}`;

        fake.uploads.push({ key, mimeType });

        if (fake.touchDuringUpload) {
          for (const row of fake.rows.values()) {
            row.updated_at = new Date(row.updated_at.getTime() + 1);
          }
        }

        return `https://bucket.sgp1.digitaloceanspaces.com/worker-images/${key}?v=${sha256(buffer).slice(0, 8)}`;
      },
      deleteWorkerProfileImageByUrl: async (url: string) => {
        fake.deletedUrls.push(url);
      },
    };
  }

  if (request.endsWith("repositories/shared/worker-image.repository")) {
    return {
      findWorkerPicture: async (workerId: number) => {
        const row = fake.rows.get(workerId);

        return row ? { ...row } : null;
      },
      listWorkerIdsWithPicture: async () =>
        [...fake.rows.values()].filter((row) => row.picture !== null).map((row) => row.id),
      listWorkerCodesWithoutPicture: async () =>
        [...fake.rows.values()].filter((row) => row.picture === null).map((row) => row.labor_code),
      listAdminImages: async () => fake.admins,
      listWorkerIdsPendingImageSync: async () =>
        [...fake.rows.values()]
          .filter((row) => row.picture !== null && (row.picture_hash === null || row.image_url === null))
          .map((row) => row.id),
      saveWorkerImage: async (
        workerId: number,
        readAt: Date,
        image: { image_url: string; picture_hash: string },
      ) => {
        const row = fake.rows.get(workerId);

        if (!row || row.updated_at.getTime() !== readAt.getTime()) {
          return false;
        }

        row.image_url = image.image_url;
        row.picture_hash = image.picture_hash;
        return true;
      },
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const workerImageService = require("../../../src/services/shared/worker-image.service") as typeof import("../../../src/services/shared/worker-image.service");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const imageCheckService = require("../../../src/services/shared/profile-image-check.service") as typeof import("../../../src/services/shared/profile-image-check.service");

/* -------------------------------------- Helpers -------------------------------------- */

// Function เพิ่มแถว worker ใน fake DB
function addRow(row: Partial<FakeWorkerRow> & { id: number }): FakeWorkerRow {
  const full: FakeWorkerRow = {
    labor_code: `MN${String(row.id).padStart(6, "0")}`,
    picture: JPEG_BYTES,
    picture_hash: null,
    image_url: null,
    updated_at: new Date("2026-10-16T00:00:00.000Z"),
    ...row,
  };

  fake.rows.set(full.id, full);
  return full;
}

// Function คำนวณ SHA-256 ของไบต์ (ใช้ตรวจผลใน test)
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

beforeEach(() => {
  fake.rows.clear();
  fake.uploads.length = 0;
  fake.deletedUrls.length = 0;
  fake.touchDuringUpload = false;
  fake.failUploadFor.clear();
  fake.spacesConfigured = true;
  fake.admins = [];
});

/* -------------------------------------- Tests -------------------------------------- */

test("detectWorkerImageType recognizes JPEG, PNG and WebP from the file header and rejects anything else", () => {
  assert.deepEqual(workerImageService.detectWorkerImageType(JPEG_BYTES), { mime_type: "image/jpeg", extension: ".jpg" });
  assert.deepEqual(workerImageService.detectWorkerImageType(PNG_BYTES), { mime_type: "image/png", extension: ".png" });
  assert.deepEqual(workerImageService.detectWorkerImageType(WEBP_BYTES), { mime_type: "image/webp", extension: ".webp" });
  assert.equal(workerImageService.detectWorkerImageType(Uint8Array.from([0x47, 0x49, 0x46, 0x38])), null);
  assert.equal(workerImageService.detectWorkerImageType(new Uint8Array()), null);
});

test("syncWorkerImage uploads a new picture and stores its URL and hash", async () => {
  const row = addRow({ id: 1 });
  const hash = sha256(JPEG_BYTES);

  assert.equal(await workerImageService.syncWorkerImage(1), "uploaded");
  assert.deepEqual(fake.uploads, [{ key: "MN000001.jpg", mimeType: "image/jpeg" }]);
  assert.equal(row.picture_hash, hash);
  assert.equal(row.image_url, `https://bucket.sgp1.digitaloceanspaces.com/worker-images/MN000001.jpg?v=${hash.slice(0, 8)}`);
});

test("syncWorkerImage skips the upload when the picture hash matches what was already uploaded", async () => {
  addRow({ id: 2, picture_hash: sha256(JPEG_BYTES), image_url: "https://bucket/worker-images/old.jpg" });

  assert.equal(await workerImageService.syncWorkerImage(2), "unchanged");
  assert.equal(fake.uploads.length, 0);
});

test("syncWorkerImage overwrites the same WorkerCode file when the picture changes and does not delete it", async () => {
  const oldUrl = "https://bucket.sgp1.digitaloceanspaces.com/worker-images/MN000003.jpg?v=11111111";
  const newPicture = Uint8Array.from([...JPEG_BYTES, 0x01]);
  const row = addRow({ id: 3, picture: newPicture, picture_hash: sha256(JPEG_BYTES), image_url: oldUrl });

  assert.equal(await workerImageService.syncWorkerImage(3), "uploaded");
  assert.deepEqual(fake.uploads, [{ key: "MN000003.jpg", mimeType: "image/jpeg" }]);
  assert.equal(row.image_url, `https://bucket.sgp1.digitaloceanspaces.com/worker-images/MN000003.jpg?v=${sha256(newPicture).slice(0, 8)}`);
  assert.deepEqual(fake.deletedUrls, []);
});

test("syncWorkerImage deletes the previous file only when the image type changed its file name", async () => {
  const oldUrl = "https://bucket.sgp1.digitaloceanspaces.com/worker-images/MN000007.jpg?v=11111111";
  const row = addRow({ id: 7, picture: PNG_BYTES, picture_hash: sha256(JPEG_BYTES), image_url: oldUrl });

  assert.equal(await workerImageService.syncWorkerImage(7), "uploaded");
  assert.equal(fake.uploads[0].key, "MN000007.png");
  assert.ok(row.image_url?.includes("/MN000007.png?v="));
  assert.deepEqual(fake.deletedUrls, [oldUrl]);
});

test("syncWorkerImage does not overwrite a row that was changed while the upload was running", async () => {
  const row = addRow({ id: 4 });
  fake.touchDuringUpload = true;

  assert.equal(await workerImageService.syncWorkerImage(4), "changed_during_sync");
  assert.equal(row.image_url, null);
  assert.equal(row.picture_hash, null);
});

test("syncWorkerImage leaves workers without a picture or with an unsupported file untouched", async () => {
  addRow({ id: 5, picture: null });
  addRow({ id: 6, picture: Uint8Array.from([0x47, 0x49, 0x46, 0x38]) });

  assert.equal(await workerImageService.syncWorkerImage(5), "no_picture");
  assert.equal(await workerImageService.syncWorkerImage(6), "unsupported_type");
  assert.equal(await workerImageService.syncWorkerImage(999), "not_found");
  assert.equal(fake.uploads.length, 0);
});

test("syncPendingWorkerImages uploads only pending workers, keeps going after a failure and reports a summary", async () => {
  addRow({ id: 10 });
  addRow({ id: 11, picture_hash: sha256(JPEG_BYTES), image_url: "https://bucket/worker-images/done.jpg" });
  addRow({ id: 12 });
  addRow({ id: 13, picture: null });
  fake.failUploadFor.add("MN000010");

  const summary = await workerImageService.syncPendingWorkerImages();

  assert.deepEqual(summary, {
    spaces_configured: true,
    total: 2,
    uploaded: 1,
    unchanged: 0,
    unsupported_type: 0,
    changed_during_sync: 0,
    failed: 1,
  });
  assert.equal(fake.rows.get(12)?.picture_hash, sha256(JPEG_BYTES));
  assert.equal(fake.rows.get(10)?.picture_hash, null);
});

test("syncPendingWorkerImages skips everything without error when Spaces is not configured", async () => {
  const row = addRow({ id: 20 });
  fake.spacesConfigured = false;

  const summary = await workerImageService.syncPendingWorkerImages();

  assert.equal(summary.spaces_configured, false);
  assert.equal(summary.total, 1);
  assert.equal(summary.uploaded, 0);
  assert.equal(summary.failed, 0);
  assert.equal(fake.uploads.length, 0);
  assert.equal(row.image_url, null);
});

test("checkProfileImages lists workers without a picture, pending uploads, and admins without an image", async () => {
  addRow({ id: 30, picture: null });
  addRow({ id: 31 });
  addRow({
    id: 32,
    picture_hash: sha256(JPEG_BYTES),
    image_url: "https://bucket.sgp1.digitaloceanspaces.com/worker-images/MN000032.jpg?v=abc",
  });
  // รูปเปลี่ยนแต่ hash ยังเป็นของรูปเก่า ต้องนับว่าค้างอัปโหลด
  addRow({ id: 33, picture: PNG_BYTES, picture_hash: sha256(JPEG_BYTES), image_url: "https://bucket/x.jpg" });
  fake.admins = [
    { id: 1, image_url: "https://bucket.sgp1.digitaloceanspaces.com/admin-images/ADM0001.jpg?v=abc" },
    { id: 2, image_url: null },
  ];

  const report = await imageCheckService.checkProfileImages({ verify: false });

  assert.deepEqual(report.worker, {
    total: 4,
    synced: 1,
    without_picture: ["MN000030"],
    pending_upload: ["MN000031", "MN000033"],
    missing_in_spaces: [],
  });
  assert.deepEqual(report.admin, { total: 2, with_image: 1, without_image: ["ADM0002"], missing_in_spaces: [] });
  assert.equal(imageCheckService.hasProfileImageProblems(report), true);
});
