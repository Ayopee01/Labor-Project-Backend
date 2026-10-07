// Import Types
import { GATE_TICKET_CHANGE_DETAIL_TYPE } from "../types/gate.type";
import type { GateTicketChangeDetail, GateTicketRevisionProduct, GateTicketRevisionSnapshot } from "../types/gate.type";

/* -------------------------------------- Types -------------------------------------- */

// Type แผง 1 แผงใน snapshot ของตั๋ว
type RevisionBooth = GateTicketRevisionSnapshot["Booths"][number];

/* -------------------------------------- Functions -------------------------------------- */

// Function ย่อสินค้าเหลือข้อมูลที่ใช้แสดงผลในรายละเอียดการแก้ตั๋ว
function compactProduct(product: GateTicketRevisionProduct): Record<string, unknown> {
  return {
    TicketProductId: product.TicketProductId ?? null,
    ProductCode: product.ProductCode,
    PackageCode: product.PackageCode,
    Quantity: product.Quantity,
    WorkerCount: product.WorkerCount,
  };
}

// Function ย่อแผงพร้อมสินค้า ใช้กับแผงที่เพิ่มหรือลบทั้งแผง
function compactBooth(booth: RevisionBooth): Record<string, unknown> {
  return {
    BoothName: booth.BoothName,
    Products: booth.Products.map(compactProduct),
  };
}

// Function อ้างอิงสินค้าในรายละเอียด (TicketProductId เป็น identity หลัก ProductCode + PackageCode ไว้แสดงผล)
function productReference(product: GateTicketRevisionProduct) {
  return {
    TicketProductId: product.TicketProductId ?? null,
    ProductCode: product.ProductCode,
    PackageCode: product.PackageCode,
  };
}

// Function เทียบสินค้าของแผงที่ยังอยู่ (snapshot เก่าไม่มี TicketProductId ใช้ ProductCode + PackageCode จับคู่)
function diffBoothProducts(before: RevisionBooth, after: RevisionBooth): GateTicketChangeDetail[] {
  const details: GateTicketChangeDetail[] = [];
  const useProductIds = [...before.Products, ...after.Products].every(
    (product) => product.TicketProductId !== undefined
  );
  const keyOf = (product: GateTicketRevisionProduct) =>
    useProductIds ? product.TicketProductId! : `${product.ProductCode}:${product.PackageCode}`;
  const afterByKey = new Map(after.Products.map((product) => [keyOf(product), product]));
  const beforeKeys = new Set(before.Products.map(keyOf));
  const booth = { BoothJobId: after.BoothJobId, BoothCode: after.BoothCode };

  for (const product of before.Products) {
    const next = afterByKey.get(keyOf(product));

    if (!next) {
      details.push({
        Type: GATE_TICKET_CHANGE_DETAIL_TYPE.PRODUCT_REMOVED,
        ...booth,
        ...productReference(product),
        Before: { Quantity: product.Quantity, WorkerCount: product.WorkerCount },
      });
      continue;
    }

    const fields: string[] = [];
    const beforeValues: Record<string, unknown> = {};
    const afterValues: Record<string, unknown> = {};

    if (product.Quantity !== next.Quantity) {
      fields.push("QUANTITY");
      beforeValues.Quantity = product.Quantity;
      afterValues.Quantity = next.Quantity;
    }

    if (product.WorkerCount !== next.WorkerCount) {
      fields.push("WORKER_COUNT");
      beforeValues.WorkerCount = product.WorkerCount;
      afterValues.WorkerCount = next.WorkerCount;
    }

    if (fields.length > 0) {
      details.push({
        Type: GATE_TICKET_CHANGE_DETAIL_TYPE.PRODUCT_UPDATED,
        ...booth,
        ...productReference(next),
        Fields: fields,
        Before: beforeValues,
        After: afterValues,
      });
    }
  }

  for (const product of after.Products) {
    if (!beforeKeys.has(keyOf(product))) {
      details.push({
        Type: GATE_TICKET_CHANGE_DETAIL_TYPE.PRODUCT_ADDED,
        ...booth,
        ...productReference(product),
        After: { Quantity: product.Quantity, WorkerCount: product.WorkerCount },
      });
    }
  }

  return details;
}

// Function สร้างรายละเอียดเฉพาะสิ่งที่ Gate แก้จาก snapshot ก่อน/หลัง (ใช้ตอน PUT และ backfill log เก่า)
export function buildGateTicketChangeDetails(
  before: GateTicketRevisionSnapshot,
  after: GateTicketRevisionSnapshot
): GateTicketChangeDetail[] {
  const details: GateTicketChangeDetail[] = [];

  if (before.MarketCode !== after.MarketCode) {
    details.push({
      Type: GATE_TICKET_CHANGE_DETAIL_TYPE.MARKET_CHANGED,
      Before: { MarketCode: before.MarketCode, MarketName: before.MarketName },
      After: { MarketCode: after.MarketCode, MarketName: after.MarketName },
    });
  }

  if ((before.DropoffPoint ?? null) !== (after.DropoffPoint ?? null)) {
    details.push({
      Type: GATE_TICKET_CHANGE_DETAIL_TYPE.DROPOFF_POINT_CHANGED,
      Before: before.DropoffPoint ?? null,
      After: after.DropoffPoint ?? null,
    });
  }

  if (before.WorkerCount !== after.WorkerCount) {
    details.push({
      Type: GATE_TICKET_CHANGE_DETAIL_TYPE.WORKER_COUNT_CHANGED,
      Before: before.WorkerCount,
      After: after.WorkerCount,
    });
  }

  // แผงจับคู่ด้วย BoothJobId (แผงที่ลบแล้วเพิ่มกลับได้ BoothJobId ใหม่ = เพิ่มแผง)
  const afterBoothById = new Map(after.Booths.map((booth) => [booth.BoothJobId, booth]));
  const beforeBoothIds = new Set(before.Booths.map((booth) => booth.BoothJobId));

  for (const booth of before.Booths) {
    const next = afterBoothById.get(booth.BoothJobId);

    if (!next) {
      details.push({
        Type: GATE_TICKET_CHANGE_DETAIL_TYPE.BOOTH_REMOVED,
        BoothJobId: booth.BoothJobId,
        BoothCode: booth.BoothCode,
        Before: compactBooth(booth),
      });
      continue;
    }

    if ((booth.BoothName ?? null) !== (next.BoothName ?? null)) {
      details.push({
        Type: GATE_TICKET_CHANGE_DETAIL_TYPE.BOOTH_UPDATED,
        BoothJobId: next.BoothJobId,
        BoothCode: next.BoothCode,
        Fields: ["BOOTH_NAME"],
        Before: { BoothName: booth.BoothName },
        After: { BoothName: next.BoothName },
      });
    }

    details.push(...diffBoothProducts(booth, next));
  }

  for (const booth of after.Booths) {
    if (!beforeBoothIds.has(booth.BoothJobId)) {
      details.push({
        Type: GATE_TICKET_CHANGE_DETAIL_TYPE.BOOTH_ADDED,
        BoothJobId: booth.BoothJobId,
        BoothCode: booth.BoothCode,
        After: compactBooth(booth),
      });
    }
  }

  return details;
}
