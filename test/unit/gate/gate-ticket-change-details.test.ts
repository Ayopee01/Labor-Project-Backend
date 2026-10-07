// Import Library
import assert from "node:assert/strict";
import { test } from "node:test";
// Import Types
import type { GateTicketRevisionSnapshot } from "../../../src/types/gate.type";
// Import Utils
import { buildGateTicketChangeDetails } from "../../../src/utils/gate-ticket-change-details";

/* -------------------------------------- Helpers -------------------------------------- */

// Function สร้าง snapshot ตั้งต้น: 2 แผง แผงละ 1 สินค้า
function buildSnapshot(): GateTicketRevisionSnapshot {
  return {
    MarketJobId: "10",
    TicketNo: "20261014101303",
    MarketCode: "M1",
    MarketName: "Market 1",
    DropoffPoint: "Gate 1",
    WorkerCount: 3,
    Booths: [
      {
        BoothJobId: "501",
        BoothCode: "IV4/62",
        BoothName: "Vendor A",
        Status: "WAIT",
        Products: [{ TicketProductId: "9001", ProductCode: "P001", PackageCode: "BOX", Quantity: 100, WorkerCount: 3 }],
      },
      {
        BoothJobId: "502",
        BoothCode: "IV4/63",
        BoothName: "Vendor B",
        Status: "WAIT",
        Products: [{ TicketProductId: "9002", ProductCode: "P002", PackageCode: "BAG", Quantity: 50, WorkerCount: 1 }],
      },
    ],
  };
}

/* -------------------------------------- Tests -------------------------------------- */

test("buildGateTicketChangeDetails returns no details when nothing changed", () => {
  assert.deepEqual(buildGateTicketChangeDetails(buildSnapshot(), buildSnapshot()), []);
});

test("buildGateTicketChangeDetails reports market, dropoff point and worker count changes with only the changed values", () => {
  const after = buildSnapshot();

  after.MarketCode = "M2";
  after.MarketName = "Market 2";
  after.DropoffPoint = "Gate 2";
  after.WorkerCount = 2;

  assert.deepEqual(buildGateTicketChangeDetails(buildSnapshot(), after), [
    {
      Type: "MARKET_CHANGED",
      Before: { MarketCode: "M1", MarketName: "Market 1" },
      After: { MarketCode: "M2", MarketName: "Market 2" },
    },
    { Type: "DROPOFF_POINT_CHANGED", Before: "Gate 1", After: "Gate 2" },
    { Type: "WORKER_COUNT_CHANGED", Before: 3, After: 2 },
  ]);
});

test("buildGateTicketChangeDetails reports booth added, removed and renamed by BoothJobId", () => {
  const after = buildSnapshot();

  after.Booths[0].BoothName = "Vendor A2";
  after.Booths[1] = {
    BoothJobId: "503",
    BoothCode: "IV4/70",
    BoothName: "Vendor C",
    Status: "WAIT",
    Products: [{ TicketProductId: "9003", ProductCode: "P003", PackageCode: "BOX", Quantity: 10, WorkerCount: 1 }],
  };

  assert.deepEqual(buildGateTicketChangeDetails(buildSnapshot(), after), [
    {
      Type: "BOOTH_UPDATED",
      BoothJobId: "501",
      BoothCode: "IV4/62",
      Fields: ["BOOTH_NAME"],
      Before: { BoothName: "Vendor A" },
      After: { BoothName: "Vendor A2" },
    },
    {
      Type: "BOOTH_REMOVED",
      BoothJobId: "502",
      BoothCode: "IV4/63",
      Before: {
        BoothName: "Vendor B",
        Products: [{ TicketProductId: "9002", ProductCode: "P002", PackageCode: "BAG", Quantity: 50, WorkerCount: 1 }],
      },
    },
    {
      Type: "BOOTH_ADDED",
      BoothJobId: "503",
      BoothCode: "IV4/70",
      After: {
        BoothName: "Vendor C",
        Products: [{ TicketProductId: "9003", ProductCode: "P003", PackageCode: "BOX", Quantity: 10, WorkerCount: 1 }],
      },
    },
  ]);
});

test("buildGateTicketChangeDetails reports product added, removed and updated by TicketProductId with only changed fields", () => {
  const after = buildSnapshot();

  after.Booths[0].Products = [
    { TicketProductId: "9001", ProductCode: "P001", PackageCode: "BOX", Quantity: 80, WorkerCount: 3 },
    { TicketProductId: "9010", ProductCode: "P010", PackageCode: "BOX", Quantity: 5, WorkerCount: 1 },
  ];
  after.Booths[1].Products = [
    { TicketProductId: "9011", ProductCode: "P011", PackageCode: "BAG", Quantity: 7, WorkerCount: 2 },
  ];

  assert.deepEqual(buildGateTicketChangeDetails(buildSnapshot(), after), [
    {
      Type: "PRODUCT_UPDATED",
      BoothJobId: "501",
      BoothCode: "IV4/62",
      TicketProductId: "9001",
      ProductCode: "P001",
      PackageCode: "BOX",
      Fields: ["QUANTITY"],
      Before: { Quantity: 100 },
      After: { Quantity: 80 },
    },
    {
      Type: "PRODUCT_ADDED",
      BoothJobId: "501",
      BoothCode: "IV4/62",
      TicketProductId: "9010",
      ProductCode: "P010",
      PackageCode: "BOX",
      After: { Quantity: 5, WorkerCount: 1 },
    },
    {
      Type: "PRODUCT_REMOVED",
      BoothJobId: "502",
      BoothCode: "IV4/63",
      TicketProductId: "9002",
      ProductCode: "P002",
      PackageCode: "BAG",
      Before: { Quantity: 50, WorkerCount: 1 },
    },
    {
      Type: "PRODUCT_ADDED",
      BoothJobId: "502",
      BoothCode: "IV4/63",
      TicketProductId: "9011",
      ProductCode: "P011",
      PackageCode: "BAG",
      After: { Quantity: 7, WorkerCount: 2 },
    },
  ]);
});

test("buildGateTicketChangeDetails reports QUANTITY and WORKER_COUNT together when both change on one product", () => {
  const after = buildSnapshot();

  after.Booths[1].Products[0].Quantity = 200;
  after.Booths[1].Products[0].WorkerCount = 2;

  assert.deepEqual(buildGateTicketChangeDetails(buildSnapshot(), after), [
    {
      Type: "PRODUCT_UPDATED",
      BoothJobId: "502",
      BoothCode: "IV4/63",
      TicketProductId: "9002",
      ProductCode: "P002",
      PackageCode: "BAG",
      Fields: ["QUANTITY", "WORKER_COUNT"],
      Before: { Quantity: 50, WorkerCount: 1 },
      After: { Quantity: 200, WorkerCount: 2 },
    },
  ]);
});
