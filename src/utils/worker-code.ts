import type { BuildWorkerCodeInput, WorkerNationality, WorkerShirtType } from "../types/admin-workers.type";
import ApiError from "./api-error";

/* -------------------------------------- Constants -------------------------------------- */

// Config สัญชาติที่นำไปสร้าง prefix ของรหัส worker ได้
export const WORKER_NATIONALITIES = ["Myanmar", "Cambodia"] as const;

// Config สีเสื้อที่นำไปสร้าง prefix ของรหัส worker ได้
export const WORKER_SHIRT_TYPES = ["Navy", "Blue", "Green"] as const;

// Config map prefix ของรหัส worker จากสัญชาติ สีเสื้อ และเลขเสื้อ 6 หลัก
const WORKER_CODE_PREFIXES: Record<
  WorkerNationality,
  Record<WorkerShirtType, string>
> = {
  Myanmar: {
    Navy: "MN",
    Blue: "MB",
    Green: "MG",
  },
  Cambodia: {
    Navy: "CN",
    Blue: "CB",
    Green: "CG",
  },
};

/* -------------------------------------- Functions -------------------------------------- */

// Function สร้าง WorkerCode สำหรับ helper กลาง
export function buildWorkerCode(input: BuildWorkerCodeInput): string {
  const nationality = input.nationality as WorkerNationality;
  const shirtType = input.shirt_type as WorkerShirtType;
  const prefix = WORKER_CODE_PREFIXES[nationality]?.[shirtType];
  const shirtNumber = input.shirt_number.trim();
  const numericShirtNumber = Number(shirtNumber);

  if (!prefix) {
    throw new ApiError(
      400,
      "INVALID_WORKER_CODE_PREFIX",
      "Worker code prefix requires nationality Myanmar/Cambodia and shirt_type Navy/Blue/Green."
    );
  }

  if (
    !/^\d+$/.test(shirtNumber) ||
    !Number.isInteger(numericShirtNumber) ||
    numericShirtNumber < 0 ||
    numericShirtNumber > 999999
  ) {
    throw new ApiError(
      400,
      "INVALID_SHIRT_NUMBER",
      "Shirt number must be a non-negative integer with at most 6 digits."
    );
  }

  return `${prefix}${String(numericShirtNumber).padStart(6, "0")}`;
}
