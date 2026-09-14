// Import Library
import { Prisma } from "@prisma/client";

// Import Dependencies
import ApiError from "./api-error";

/* -------------------------------------- Types -------------------------------------- */

export type WorkerRanges = {
  range1To50: number;
  range51To100: number;
  range101To200: number;
  range201To400: number;
  range401To600: number;
  rangeOver600: number;
};

export type MasterProductRange = {
  workerRanges: WorkerRanges;
};

export type WorkerRangeCode =
  | "RANGE_1_TO_50"
  | "RANGE_51_TO_100"
  | "RANGE_101_TO_200"
  | "RANGE_201_TO_400"
  | "RANGE_401_TO_600"
  | "RANGE_OVER_600";

export type WorkerRequirementCalculation = {
  rangeCode: WorkerRangeCode;
  requiredWorkerCount: number;
};

export type ProductStallChargeCalculationInput = {
  quantity: Prisma.Decimal;
  stallRate: Prisma.Decimal;
  laborRate: Prisma.Decimal;
};

export type ProductStallChargeCalculation = {
  quantity: Prisma.Decimal;

  stallRate: Prisma.Decimal;
  laborRate: Prisma.Decimal;
  stallFeeRaw: Prisma.Decimal;// Quantity × PackagePrice
  stallFeeRounded: Prisma.Decimal;// CEIL(stallFeeRaw)
  laborFeeRaw: Prisma.Decimal;// Quantity × PackageRate
  productCharge: Prisma.Decimal;// CEIL(stallFeeRounded + laborFeeRaw)
};

export type ProductWorkerPaymentCalculationInput = {
  laborFeeRaw: Prisma.Decimal;
  actualWorkerCount: number;
};

export type ProductWorkerPaymentCalculation = {
  laborFeeRaw: Prisma.Decimal;
  actualWorkerCount: number;
  rawAmountPerWorker: Prisma.Decimal;  // ค่าแรงเต็ม ÷ Worker
  finalAmountPerWorker: Prisma.Decimal;  // เงินเต็มที่ Worker ได้จริง
  remainderAmountPerWorker: Prisma.Decimal;  // เศษของ Worker 1 คน
  workerPayoutTotal: Prisma.Decimal;  // เงินที่ Worker ทุกคนได้รับจริงรวมกัน
  fundAmount: Prisma.Decimal;  // เศษทั้งหมดของ Product ที่เข้ากองทุน
};

/* -------------------------------------- Config -------------------------------------- */

const WORKER_RANGE_KEYS = [
  "range1To50",
  "range51To100",
  "range101To200",
  "range201To400",
  "range401To600",
  "rangeOver600",
] as const;

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจว่า JSON value เป็น object ปกติก่อนอ่าน range
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// Function ตรวจ integer บวกและโยน ApiError กลาง
function assertPositiveInteger(value: number, code: string, message: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ApiError(400, code, message);
  }
}

// Function ตรวจ Decimal ว่า finite และไม่ติดลบ
function assertNonNegativeDecimal(
  value: Prisma.Decimal,
  code: string,
  message: string
): void {
  if (!value.isFinite() || value.isNegative()) {
    throw new ApiError(400, code, message);
  }
}

// Function แปลง Decimal เป็น string ทศนิยม 2 ตำแหน่ง — ใช้ร่วมกันทั้งเงินและน้ำหนัก (สูตรเดียวกัน)
function decimalToFixedString(value: Prisma.Decimal): string {
  return value.toFixed(2);
}

// Function แปลง Decimal เงินเป็น string ทศนิยม 2 ตำแหน่ง
export function decimalToMoneyString(value: Prisma.Decimal): string {
  return decimalToFixedString(value);
}

// Function แปลง Decimal น้ำหนักเป็น string ทศนิยม 2 ตำแหน่ง
export function decimalToWeightString(value: Prisma.Decimal): string {
  return decimalToFixedString(value);
}

// Function ตรวจและแปลง workerRanges จาก master_product
export function parseMasterProductRange(value: Prisma.JsonValue): MasterProductRange {
  if (!isPlainRecord(value)) {
    throw new ApiError(
      409,
      "MASTER_PRODUCT_RANGE_INVALID",
      "Master product range must be an object."
    );
  }

  const workerRanges = value.workerRanges;

  if (!isPlainRecord(workerRanges)) {
    throw new ApiError(
      409,
      "MASTER_PRODUCT_RANGE_INVALID",
      "Master product range.workerRanges must be an object."
    );
  }

  const parsedRanges = {} as WorkerRanges;

  for (const key of WORKER_RANGE_KEYS) {
    const rangeValue: unknown = workerRanges[key];

    if (
      typeof rangeValue !== "number" ||
      !Number.isInteger(rangeValue) ||
      rangeValue < 0
    ) {
      throw new ApiError(
        409,
        "MASTER_PRODUCT_RANGE_INVALID",
        `Master product worker range ${key} must be a non-negative integer.`
      );
    }

    parsedRanges[key] = rangeValue;
  }

  return {
    workerRanges: parsedRanges,
  };
}

// Function คำนวณจำนวน Worker ที่ต้องใช้จากจำนวนสินค้าและ range
export function calculateRequiredWorkerCount(
  quantity: number,
  ranges: WorkerRanges
): WorkerRequirementCalculation {
  assertPositiveInteger(quantity, "INVALID_QUANTITY", "Quantity must be a positive integer.");

  const selected =
    quantity <= 50
      ? { rangeCode: "RANGE_1_TO_50" as const, requiredWorkerCount: ranges.range1To50 }
      : quantity <= 100
        ? { rangeCode: "RANGE_51_TO_100" as const, requiredWorkerCount: ranges.range51To100 }
        : quantity <= 200
          ? { rangeCode: "RANGE_101_TO_200" as const, requiredWorkerCount: ranges.range101To200 }
          : quantity <= 400
            ? { rangeCode: "RANGE_201_TO_400" as const, requiredWorkerCount: ranges.range201To400 }
            : quantity <= 600
              ? { rangeCode: "RANGE_401_TO_600" as const, requiredWorkerCount: ranges.range401To600 }
              : { rangeCode: "RANGE_OVER_600" as const, requiredWorkerCount: ranges.rangeOver600 };

  if (selected.requiredWorkerCount <= 0) {
    throw new ApiError(
      409,
      "WORKER_RANGE_NOT_CONFIGURED",
      "Worker range is not configured for this product quantity.",
      {
        range_code: selected.rangeCode,
      }
    );
  }

  return selected;
}

// Function แปลง packageWeight จาก master_product เป็น Decimal
export function packageWeightToDecimal(packageWeight: number): Prisma.Decimal {
  if (!Number.isFinite(packageWeight) || packageWeight <= 0) {
    throw new ApiError(
      409,
      "INVALID_PACKAGE_WEIGHT",
      "Master product package weight must be greater than zero."
    );
  }

  return new Prisma.Decimal(String(packageWeight));
}

// Function คำนวณยอดเก็บเงินของสินค้าในแผงด้วย Method A
export function calculateProductStallCharge(
  input: ProductStallChargeCalculationInput
): ProductStallChargeCalculation {
  assertNonNegativeDecimal(
    input.quantity,
    "INVALID_QUANTITY",
    "Quantity must not be negative."
  );

  assertNonNegativeDecimal(
    input.stallRate,
    "INVALID_STALL_RATE",
    "Stall rate must not be negative."
  );

  assertNonNegativeDecimal(
    input.laborRate,
    "INVALID_LABOR_RATE",
    "Labor rate must not be negative."
  );

  const stallFeeRaw =
    input.quantity.mul(input.stallRate);

  // Format Method A: ปัดยอดแผงขึ้นก่อน
  const stallFeeRounded =
    stallFeeRaw.ceil();

  // Format ค่าแรงยังไม่ปัด
  const laborFeeRaw =
    input.quantity.mul(input.laborRate);

  // Format ยอดสินค้าสุดท้ายคือปัดขึ้นอีกครั้งหลังรวมค่าแรง
  const productCharge =
    stallFeeRounded
      .plus(laborFeeRaw)
      .ceil();

  if (
    stallFeeRounded.lt(stallFeeRaw) ||
    productCharge.lt(
      stallFeeRounded.plus(laborFeeRaw)
    )
  ) {
    throw new ApiError(
      500,
      "STALL_PAYMENT_CALCULATION_INVALID",
      "Stall payment calculation is invalid."
    );
  }

  return {
    quantity: input.quantity,

    stallRate: input.stallRate,
    laborRate: input.laborRate,

    stallFeeRaw,
    stallFeeRounded,
    laborFeeRaw,
    productCharge,
  };
}

// Function คำนวณเงิน Worker ต่อสินค้าและเก็บเศษเข้ากองทุน
export function calculateProductWorkerPayment(
  input: ProductWorkerPaymentCalculationInput
): ProductWorkerPaymentCalculation {
  assertNonNegativeDecimal(
    input.laborFeeRaw,
    "INVALID_LABOR_FEE",
    "Labor fee must not be negative."
  );

  assertPositiveInteger(
    input.actualWorkerCount,
    "ACTUAL_WORKER_COUNT_INVALID",
    "Actual worker count must be a positive integer."
  );

  // Format ค่าแรงเต็มของสินค้า ÷ Worker จริงในแผง
  const rawAmountPerWorker =
    input.laborFeeRaw.div(
      input.actualWorkerCount
    );

  // Format Worker รับเฉพาะจำนวนบาทเต็ม
  const finalAmountPerWorker =
    rawAmountPerWorker.floor();

  // Format เศษของ Worker หนึ่งคน
  const remainderAmountPerWorker =
    rawAmountPerWorker.minus(
      finalAmountPerWorker
    );

  // Format เงินรวมที่ Worker ทุกคนได้รับจริง
  const workerPayoutTotal =
    finalAmountPerWorker.mul(
      input.actualWorkerCount
    );

  // Format กองทุนคำนวณจากยอดค่าแรงจริงหลังหักเงิน Worker รวม
  const fundAmount =
    input.laborFeeRaw.minus(
      workerPayoutTotal
    );

  if (
    fundAmount.isNegative() ||
    remainderAmountPerWorker.isNegative() ||
    !workerPayoutTotal
      .plus(fundAmount)
      .equals(input.laborFeeRaw)
  ) {
    throw new ApiError(
      500,
      "WORKER_PAYMENT_CALCULATION_INVALID",
      "Worker payment calculation is invalid."
    );
  }

  // Format ค่าเงินที่ persist ต้องตรง scale Decimal(20,8)
  const rawAmountPerWorkerToPersist = rawAmountPerWorker.toDecimalPlaces(8);
  const remainderAmountPerWorkerToPersist = remainderAmountPerWorker.toDecimalPlaces(8);

  return {
    laborFeeRaw:
      input.laborFeeRaw,

    actualWorkerCount:
      input.actualWorkerCount,

    rawAmountPerWorker: rawAmountPerWorkerToPersist,
    finalAmountPerWorker,
    remainderAmountPerWorker: remainderAmountPerWorkerToPersist,

    workerPayoutTotal,
    fundAmount,
  };
}
