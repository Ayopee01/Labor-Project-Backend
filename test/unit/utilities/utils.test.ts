import assert from "node:assert/strict";
import { before, test } from "node:test";
import { Prisma } from "@prisma/client";

import type ApiErrorClass from "../../../src/utils/api-error";

/* -------------------------------------- Test Env -------------------------------------- */

// ต้องยาวอย่างน้อย 32 ตัวอักษรเพื่อผ่านเกณฑ์ความแข็งแรงของ Secret ที่ jwt.ts/refresh-token-hash.ts เช็ค
process.env.JWT_ACCESS_SECRET = "test-access-secret-min-32-charss";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-min-32-chars";
process.env.JWT_LOGIN_CHALLENGE_SECRET = "test-login-challenge-secret-min-32";
process.env.REFRESH_TOKEN_HASH_SECRET = "test-refresh-hash-secret-min-32-ok";

/* -------------------------------------- Test Modules -------------------------------------- */

let ApiError: typeof ApiErrorClass;
let jwt: typeof import("../../../src/utils/jwt");
let password: typeof import("../../../src/utils/password");
let refreshTokenHash: typeof import("../../../src/utils/refresh-token-hash");
let shift: typeof import("../../../src/utils/shift");
let laborJobPricing: typeof import("../../../src/utils/labor-job-pricing");
let authConfig: typeof import("../../../src/config/auth.config");
let schemas: typeof import("../../../src/validation/schemas");
let apiCase: typeof import("../../../src/middlewares/api-case.middleware");

before(async () => {
  const apiErrorModule = await import("../../../src/utils/api-error");

  ApiError = apiErrorModule.default;
  jwt = await import("../../../src/utils/jwt");
  password = await import("../../../src/utils/password");
  refreshTokenHash = await import("../../../src/utils/refresh-token-hash");
  shift = await import("../../../src/utils/shift");
  laborJobPricing = await import("../../../src/utils/labor-job-pricing");
  authConfig = await import("../../../src/config/auth.config");
  schemas = await import("../../../src/validation/schemas");
  apiCase = await import("../../../src/middlewares/api-case.middleware");
});

/* -------------------------------------- JWT Tests -------------------------------------- */

test("jwt utilities sign and verify token types", () => {
  const accessToken = jwt.signAccessToken(
    {
      account_id: 1,
      role: "admin",
      session_id: 2,
    },
    { expiresIn: "1m" }
  );
  const refreshJwt = jwt.signRefreshToken(
    {
      account_id: 1,
      role: "admin",
      session_id: 2,
    },
    { expiresIn: "1m" }
  );
  const challengeToken = jwt.signLoginChallengeToken(
    {
      account_id: 1,
      role: "worker",
      old_session_id: 2,
      new_device_id: "browser-device-id",
    },
    { expiresIn: "1m" }
  );

  assert.equal(jwt.verifyAccessToken(accessToken).token_type, "access");
  assert.equal(jwt.verifyRefreshToken(refreshJwt).token_type, "refresh");
  assert.equal(
    jwt.verifyLoginChallengeToken(challengeToken).token_type,
    "login_challenge"
  );
});

test("jwt utilities reject wrong token type", () => {
  const accessToken = jwt.signAccessToken(
    {
      account_id: 1,
      role: "admin",
      session_id: 2,
    },
    { expiresIn: "1m" }
  );

  assert.throws(
    () => jwt.verifyRefreshToken(accessToken),
    (error) => error instanceof ApiError && error.code === "INVALID_REFRESH_TOKEN"
  );
});

/* -------------------------------------- Password/Hash Tests -------------------------------------- */

test("password utilities hash and verify passwords", async () => {
  const passwordHash = await password.hashPassword("Admin@123456");

  assert.equal(await password.verifyPassword("Admin@123456", passwordHash), true);
  assert.equal(await password.verifyPassword("wrong-password", passwordHash), false);
});

test("refresh token hash utilities hash and compare safely", () => {
  const hash = refreshTokenHash.hashRefreshToken("refresh-token");

  assert.equal(refreshTokenHash.refreshTokenHashesMatch(hash, hash), true);
  assert.equal(
    refreshTokenHash.refreshTokenHashesMatch(
      hash,
      refreshTokenHash.hashRefreshToken("other-token")
    ),
    false
  );
});

/* -------------------------------------- Auth Config Tests -------------------------------------- */

test("auth config parses access token expiry units", () => {
  const previousExpiresIn = process.env.JWT_ACCESS_EXPIRES_IN;

  try {
    process.env.JWT_ACCESS_EXPIRES_IN = "15m";
    assert.equal(authConfig.getAccessTokenExpiresInSeconds(), 900);

    process.env.JWT_ACCESS_EXPIRES_IN = "2h";
    assert.equal(authConfig.getAccessTokenExpiresInSeconds(), 7200);

    process.env.JWT_ACCESS_EXPIRES_IN = "30";
    assert.equal(authConfig.getAccessTokenExpiresInSeconds(), 30);

    process.env.JWT_ACCESS_EXPIRES_IN = "invalid";
    assert.equal(
      authConfig.getAccessTokenExpiresInSeconds(),
      authConfig.AUTH_DEFAULTS.accessTokenExpiresInSeconds
    );
  } finally {
    if (previousExpiresIn === undefined) {
      delete process.env.JWT_ACCESS_EXPIRES_IN;
    } else {
      process.env.JWT_ACCESS_EXPIRES_IN = previousExpiresIn;
    }
  }
});

/* -------------------------------------- Schema Tests -------------------------------------- */

test("login body schema allows device fields to be omitted", () => {
  const loginBody = schemas.loginBodySchema.parse({
    username: "admin",
    password: "Admin@123456",
  });

  assert.equal(loginBody.username, "admin");
  assert.equal(loginBody.device_id, undefined);
  assert.equal(loginBody.device_name, undefined);
});

test("gate vehicle job schema accepts multi booth PascalCase Gate body", () => {
  const gateBody = schemas.boothJobJobBodySchema.parse({
    TicketNumber: "20260723000001",
    TicketNo: "20260723000002",
    TicketCreatedAt: "2026-07-23T14:30:00+07:00",
    BoothCount: 2,
    MarketCode: "MARKET-A",
    DropoffPoint: "Gate 1 - Zone A",
    LicensePlate: "ABC-1234",
    LicensePlateProvince: "Bangkok",
    VehicleTypeCode: "PICKUP",
    VehicleTypeName: "Pickup truck",
    Booths: [
      {
        BoothCode: "BOOTH-A01",
        Products: [
          {
            ProductCode: "PRODUCT-DISPATCH-NOW",
            PackageCode: "CRATE",
            Quantity: 10,
          },
        ],
      },
      {
        BoothCode: "BOOTH-A02",
        Products: [
          {
            ProductCode: "PRODUCT-002",
            PackageCode: "BOX",
            Quantity: 20,
          },
          {
            ProductCode: "PRODUCT-003",
            PackageCode: "BAG",
            Quantity: 30,
          },
        ],
      },
    ],
    Dispatch: true,
  });

  assert.equal(gateBody.Dispatch, true);
  assert.equal(gateBody.VehicleTypeName, "Pickup truck");
  assert.equal(gateBody.BoothCount, 2);
  assert.equal(gateBody.Booths.length, 2);
  assert.equal(gateBody.Booths[0].BoothCode, "BOOTH-A01");
  assert.equal(gateBody.Booths[0].Products.length, 1);
  assert.equal(
    gateBody.Booths[0].Products[0].ProductCode,
    "PRODUCT-DISPATCH-NOW"
  );
  assert.equal(gateBody.Booths[1].BoothCode, "BOOTH-A02");
  assert.equal(gateBody.Booths[1].Products.length, 2);
  assert.equal(gateBody.Booths[1].Products[0].PackageCode, "BOX");
  assert.equal(gateBody.Booths[1].Products[1].Quantity, 30);
  assert.equal("ProductFullCode" in gateBody.Booths[0].Products[0], false);
  assert.equal("workersRequired" in gateBody, false);
});

test("gate vehicle job schema rejects BoothCount mismatch", () => {
  assert.throws(() =>
    schemas.boothJobJobBodySchema.parse({
      TicketNumber: "TRUCK-BOOTH-COUNT-MISMATCH",
      TicketNo: "TKT-BOOTH-COUNT-MISMATCH",
      TicketCreatedAt: "2026-07-23T14:30:00+07:00",
      BoothCount: 2,
      MarketCode: "MARKET-A",
      LicensePlate: "ABC-1234",
      LicensePlateProvince: "Bangkok",
      VehicleTypeCode: "PICKUP",
      VehicleTypeName: "Pickup truck",
      Booths: [
        {
          BoothCode: "BOOTH-A01",
          Products: [
            {
              ProductCode: "PRODUCT-001",
              PackageCode: "CRATE",
              Quantity: 10,
            },
          ],
        },
      ],
      Dispatch: true,
    })
  );
});

test("gate vehicle job schema rejects duplicate BoothCode", () => {
  assert.throws(() =>
    schemas.boothJobJobBodySchema.parse({
      TicketNumber: "TRUCK-DUPLICATE-BOOTH",
      TicketNo: "TKT-DUPLICATE-BOOTH",
      TicketCreatedAt: "2026-07-23T14:30:00+07:00",
      BoothCount: 2,
      MarketCode: "MARKET-A",
      LicensePlate: "ABC-1234",
      LicensePlateProvince: "Bangkok",
      VehicleTypeCode: "PICKUP",
      VehicleTypeName: "Pickup truck",
      Booths: [
        {
          BoothCode: "BOOTH-A01",
          Products: [
            {
              ProductCode: "PRODUCT-001",
              PackageCode: "CRATE",
              Quantity: 10,
            },
          ],
        },
        {
          BoothCode: "BOOTH-A01",
          Products: [
            {
              ProductCode: "PRODUCT-002",
              PackageCode: "BOX",
              Quantity: 20,
            },
          ],
        },
      ],
      Dispatch: true,
    })
  );
});

test("gate vehicle job schema rejects duplicate ProductCode and PackageCode in same booth", () => {
  assert.throws(() =>
    schemas.boothJobJobBodySchema.parse({
      TicketNumber: "TRUCK-DUPLICATE-PRODUCT",
      TicketNo: "TKT-DUPLICATE-PRODUCT",
      TicketCreatedAt: "2026-07-23T14:30:00+07:00",
      BoothCount: 1,
      MarketCode: "MARKET-A",
      LicensePlate: "ABC-1234",
      LicensePlateProvince: "Bangkok",
      VehicleTypeCode: "PICKUP",
      VehicleTypeName: "Pickup truck",
      Booths: [
        {
          BoothCode: "BOOTH-A01",
          Products: [
            {
              ProductCode: "PRODUCT-001",
              PackageCode: "CRATE",
              Quantity: 10,
            },
            {
              ProductCode: "PRODUCT-001",
              PackageCode: "CRATE",
              Quantity: 20,
            },
          ],
        },
      ],
      Dispatch: true,
    })
  );
});

test("API case utilities normalize PascalCase request payloads", () => {
  const payload = apiCase.normalizeApiRequestPayload({
    DeviceId: "mobile-001",
    WorkerCodes: ["MN000012"],
    WorkerAcceptDeadlineSeconds: 60,
    TotalEarnings: "12.00",
    Earnings: {
      TotalAmount: "12.00",
      Booths: [
        {
          TicketId: 977,
          MembershipStatus: "COMPLETED",
          Products: [
            {
              FinalAmount: "9.00",
            },
          ],
        },
      ],
    },
    Items: [
      {
        ProductCode: "PRODUCT-001",
        ConfirmedQuantity: 8,
      },
    ],
  });

  assert.deepEqual(payload, {
    device_id: "mobile-001",
    worker_codes: ["MN000012"],
    worker_accept_deadline_seconds: 60,
    total_earnings: "12.00",
    earnings: {
      total_amount: "12.00",
      booths: [
        {
          ticket_id: 977,
          membership_status: "COMPLETED",
          products: [
            {
              final_amount: "9.00",
            },
          ],
        },
      ],
    },
    items: [
      {
        productCode: "PRODUCT-001",
        confirmed_quantity: 8,
      },
    ],
  });
});

test("API case utilities transform response payloads to PascalCase", () => {
  const payload = apiCase.toPascalCasePayload({
    access_token: "access",
    driver_qr_token: "DRV-001",
    vehicle_job: {
      ticketNo: "TKT-001",
      latest_activity_at: "2026-07-24T10:00:00.000Z",
    },
  });

  assert.deepEqual(payload, {
    AccessToken: "access",
    DriverQrToken: "DRV-001",
    VehicleJob: {
      TicketNo: "TKT-001",
      LatestActivityAt: "2026-07-24T10:00:00.000Z",
    },
  });
});

test("worker schemas accept time_work on create and time-only shifts on update", () => {
  const createBody = schemas.createUserBodySchema.parse({
    full_name: "Worker One",
    phone: "0812345678",
    nationality: "Myanmar",
    shirt_type: "Navy",
    shirt_number: "12",
    time_work: "Morning",
  });
  const updateBody = schemas.updateUserBodySchema.parse({
    time_in: "08:00",
    time_out: "17:00",
  });

  assert.equal(createBody.time_work, "Morning");
  assert.equal(createBody.work_start_date, undefined);
  assert.equal(updateBody.time_in, "08:00");
  assert.equal(updateBody.time_out, "17:00");
});

test("worker update schema rejects time_work changes", () => {
  assert.throws(() =>
    schemas.updateUserBodySchema.parse({
      time_work: "Evening",
    })
  );
});

test("worker schemas reject date-time values for shifts", () => {
  assert.throws(() =>
    schemas.updateUserBodySchema.parse({
      time_in: "2026-07-03T08:00:00+07:00",
      time_out: "2026-07-03T17:00:00+07:00",
    })
  );
});

test("worker create schema rejects missing or invalid time_work", () => {
  assert.throws(() =>
    schemas.createUserBodySchema.parse({
      full_name: "Worker One",
      phone: "0812345678",
      nationality: "Myanmar",
      shirt_type: "Navy",
      shirt_number: "12",
      work_start_date: "2026-07-03",
    })
  );

  assert.throws(() =>
    schemas.createUserBodySchema.parse({
      full_name: "Worker One",
      phone: "0812345678",
      nationality: "Myanmar",
      shirt_type: "Navy",
      shirt_number: "12",
      time_work: "Afternoon",
    })
  );
});

test("shift utility builds a stable break counter key for one shift instance", () => {
  const schedule = {
    id: 1,
    worker_id: 1,
    time_work: "Evening",
    work_date: "2026-07-13",
    time_in: "18:00",
    time_out: "08:00",
    is_current: true,
    created_by: null,
    updated_by: null,
    created_at: "2026-07-13T00:00:00.000Z",
    updated_at: "2026-07-13T00:00:00.000Z",
  };

  assert.equal(
    shift.buildWorkScheduleShiftInstanceKey(
      schedule,
      new Date("2026-07-13T19:00:00+07:00")
    ),
    "2026-07-13:18:00-08:00"
  );
  assert.equal(
    shift.buildWorkScheduleShiftInstanceKey(
      schedule,
      new Date("2026-07-14T02:00:00+07:00")
    ),
    "2026-07-13:18:00-08:00"
  );
  assert.equal(
    shift.buildWorkScheduleShiftInstanceKey(
      schedule,
      new Date("2026-07-14T19:00:00+07:00")
    ),
    "2026-07-14:18:00-08:00"
  );
});

test("update user schema allows partial profile updates", () => {
  const updateBody = schemas.updateUserBodySchema.parse({
    profile: {
      shirt_number: "12",
    },
  });

  assert.equal(updateBody.profile?.shirt_number, "12");
  assert.equal("worker_code" in (updateBody.profile ?? {}), false);
});

/* -------------------------------------- Labor Job Pricing Tests -------------------------------------- */

test("labor job pricing parses master product worker ranges", () => {
  const parsed = laborJobPricing.parseMasterProductRange({
    workerRanges: {
      range1To50: 1,
      range51To100: 2,
      range101To200: 3,
      range201To400: 4,
      range401To600: 4,
      rangeOver600: 5,
    },
  });

  assert.equal(parsed.workerRanges.range101To200, 3);
  assert.throws(
    () =>
      laborJobPricing.parseMasterProductRange({
        workerRanges: {
          range1To50: 1,
          range51To100: 2,
          range101To200: 3,
          range201To400: 4,
          range401To600: 4,
          rangeOver600: -1,
        },
      }),
    (error) => error instanceof ApiError && error.code === "MASTER_PRODUCT_RANGE_INVALID"
  );
});

test("labor job pricing calculates required workers by quantity range", () => {
  const ranges = {
    range1To50: 1,
    range51To100: 2,
    range101To200: 3,
    range201To400: 4,
    range401To600: 5,
    rangeOver600: 6,
  };

  assert.deepEqual(laborJobPricing.calculateRequiredWorkerCount(1, ranges), {
    rangeCode: "RANGE_1_TO_50",
    requiredWorkerCount: 1,
  });
  assert.deepEqual(laborJobPricing.calculateRequiredWorkerCount(50, ranges), {
    rangeCode: "RANGE_1_TO_50",
    requiredWorkerCount: 1,
  });
  assert.deepEqual(laborJobPricing.calculateRequiredWorkerCount(51, ranges), {
    rangeCode: "RANGE_51_TO_100",
    requiredWorkerCount: 2,
  });
  assert.deepEqual(laborJobPricing.calculateRequiredWorkerCount(601, ranges), {
    rangeCode: "RANGE_OVER_600",
    requiredWorkerCount: 6,
  });
  assert.throws(
    () => laborJobPricing.calculateRequiredWorkerCount(0, ranges),
    (error) => error instanceof ApiError && error.code === "INVALID_QUANTITY"
  );
});

// Test Method A โดยเฉพาะ
test("labor job pricing calculates stall charge using Method A", () => {
  const payment =
    laborJobPricing.calculateProductStallCharge({
      quantity:
        new Prisma.Decimal("1"),

      stallRate:
        new Prisma.Decimal("3.20"),

      laborRate:
        new Prisma.Decimal("0.10"),
    });

  assert.equal(
    laborJobPricing.decimalToMoneyString(
      payment.stallFeeRaw
    ),
    "3.20"
  );

  assert.equal(
    laborJobPricing.decimalToMoneyString(
      payment.stallFeeRounded
    ),
    "4.00"
  );

  assert.equal(
    laborJobPricing.decimalToMoneyString(
      payment.laborFeeRaw
    ),
    "0.10"
  );

  assert.equal(
    laborJobPricing.decimalToMoneyString(
      payment.productCharge
    ),
    "5.00"
  );
});

// Test ตัวอย่าง Worker จากไฟล์ Rate
test("labor job pricing splits labor payment and stores worker remainders as fund", () => {
  const payment =
    laborJobPricing.calculateProductWorkerPayment({
      laborFeeRaw:
        new Prisma.Decimal("818.10"),

      actualWorkerCount:
        9,
    });

  assert.equal(
    payment.rawAmountPerWorker.toFixed(8),
    "90.90000000"
  );

  assert.equal(
    laborJobPricing.decimalToMoneyString(
      payment.finalAmountPerWorker
    ),
    "90.00"
  );

  assert.equal(
    laborJobPricing.decimalToMoneyString(
      payment.remainderAmountPerWorker
    ),
    "0.90"
  );

  assert.equal(
    laborJobPricing.decimalToMoneyString(
      payment.workerPayoutTotal
    ),
    "810.00"
  );

  assert.equal(
    laborJobPricing.decimalToMoneyString(
      payment.fundAmount
    ),
    "8.10"
  );

  assert.equal(
    payment.workerPayoutTotal
      .plus(payment.fundAmount)
      .equals(payment.laborFeeRaw),
    true
  );
});

//Test กรณีหารไม่ลงตัว
test("labor job pricing calculates fund from labor fee instead of rounded worker remainder", () => {
  const payment =
    laborJobPricing.calculateProductWorkerPayment({
      laborFeeRaw:
        new Prisma.Decimal("100.00"),

      actualWorkerCount:
        3,
    });

  assert.equal(
    payment.rawAmountPerWorker.toFixed(8),
    "33.33333333"
  );

  // Test Decimal(20,8) rounding before persist
  assert.ok(payment.rawAmountPerWorker.decimalPlaces() <= 8);
  assert.ok(payment.remainderAmountPerWorker.decimalPlaces() <= 8);

  assert.equal(
    laborJobPricing.decimalToMoneyString(
      payment.finalAmountPerWorker
    ),
    "33.00"
  );

  assert.equal(
    laborJobPricing.decimalToMoneyString(
      payment.workerPayoutTotal
    ),
    "99.00"
  );

  assert.equal(
    laborJobPricing.decimalToMoneyString(
      payment.fundAmount
    ),
    "1.00"
  );

  assert.equal(
    payment.workerPayoutTotal
      .plus(payment.fundAmount)
      .equals(payment.laborFeeRaw),
    true
  );
});

// Test validation เพิ่ม
test("labor job pricing rejects invalid worker count", () => {
  assert.throws(
    () =>
      laborJobPricing.calculateProductWorkerPayment({
        laborFeeRaw:
          new Prisma.Decimal("100.00"),

        actualWorkerCount:
          0,
      }),

    (error) =>
      error instanceof ApiError &&
      error.code ===
      "ACTUAL_WORKER_COUNT_INVALID"
  );
});

test("labor job pricing allows zero confirmed quantity", () => {
  const stallCharge =
    laborJobPricing.calculateProductStallCharge({
      quantity:
        new Prisma.Decimal("0.00"),

      stallRate:
        new Prisma.Decimal("6.00"),

      laborRate:
        new Prisma.Decimal("4.44"),
    });

  assert.equal(
    laborJobPricing.decimalToMoneyString(
      stallCharge.stallFeeRaw
    ),
    "0.00"
  );

  assert.equal(
    laborJobPricing.decimalToMoneyString(
      stallCharge.stallFeeRounded
    ),
    "0.00"
  );

  assert.equal(
    laborJobPricing.decimalToMoneyString(
      stallCharge.laborFeeRaw
    ),
    "0.00"
  );

  assert.equal(
    laborJobPricing.decimalToMoneyString(
      stallCharge.productCharge
    ),
    "0.00"
  );

  const workerPayment =
    laborJobPricing.calculateProductWorkerPayment({
      laborFeeRaw:
        stallCharge.laborFeeRaw,

      actualWorkerCount: 3,
    });

  assert.equal(
    laborJobPricing.decimalToMoneyString(
      workerPayment.finalAmountPerWorker
    ),
    "0.00"
  );

  assert.equal(
    laborJobPricing.decimalToMoneyString(
      workerPayment.workerPayoutTotal
    ),
    "0.00"
  );

  assert.equal(
    laborJobPricing.decimalToMoneyString(
      workerPayment.fundAmount
    ),
    "0.00"
  );
});

/* -------------------------------------- Shift Tests -------------------------------------- */

test("shift utility calculates shifts from start time", () => {
  const morningShift = shift.calculateShiftName("06:00");
  const nightShift = shift.calculateShiftName("18:00");
  assert.equal(morningShift, "Morning shift");
  assert.equal(nightShift, "Evening shift");

  assert.equal(shift.calculateShiftName("08:00"), morningShift);
  assert.equal(shift.calculateShiftName("17:59"), morningShift);
  assert.equal(shift.calculateShiftName("18:00"), nightShift);
  assert.notEqual(morningShift, nightShift);
});

test("shift utility rejects invalid shift time", () => {
  assert.throws(
    () => shift.calculateShiftName("25:00"),
    (error) => error instanceof ApiError && error.code === "INVALID_TIME_FORMAT"
  );
});

test("shift utility checks whether a time is inside work schedule", () => {
  const morningSchedule = {
    id: 1,
    worker_id: 1,
    time_work: "Morning",
    work_date: "2026-07-07",
    time_in: "08:00",
    time_out: "17:00",
    is_current: true,
    created_by: null,
    updated_by: null,
    created_at: "2026-07-07T00:00:00.000Z",
    updated_at: "2026-07-07T00:00:00.000Z",
  };
  const nightSchedule = {
    ...morningSchedule,
    time_in: "18:00",
    time_out: "06:00",
  };

  assert.equal(
    shift.isTimeInWorkSchedule(
      morningSchedule,
      new Date("2026-07-13T08:30:00+07:00")
    ),
    true
  );
  assert.equal(
    shift.isTimeInWorkSchedule(
      morningSchedule,
      new Date("2026-07-13T17:00:00+07:00")
    ),
    false
  );
  assert.equal(
    shift.isTimeInWorkSchedule(
      nightSchedule,
      new Date("2026-07-14T02:00:00+07:00")
    ),
    true
  );
  assert.equal(
    shift.isTimeInWorkSchedule(
      nightSchedule,
      new Date("2026-07-14T07:00:00+07:00")
    ),
    false
  );

  const waitInfo = shift.buildShiftWaitInfo(
    morningSchedule,
    new Date("2026-07-13T05:32:00+07:00")
  );

  assert.equal(waitInfo.shift.name, "Morning shift");
  assert.equal(waitInfo.shift.start_time, "08:00");
  assert.equal(waitInfo.shift.end_time, "17:00");
  assert.equal(waitInfo.remaining_time, "2 hours 28 minutes");
});
