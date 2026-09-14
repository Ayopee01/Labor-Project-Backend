import assert from "node:assert/strict";
import { test } from "node:test";

import { buildWorkerCode } from "../../../src/utils/worker-code";

/* -------------------------------------- Worker Code Tests -------------------------------------- */

test("buildWorkerCode formats worker code from nationality, shirt type, and shirt number", () => {
  assert.equal(
    buildWorkerCode({
      nationality: "Myanmar",
      shirt_type: "Navy",
      shirt_number: "142",
    }),
    "MN000142"
  );
  assert.equal(
    buildWorkerCode({
      nationality: "Cambodia",
      shirt_type: "Navy",
      shirt_number: "142",
    }),
    "CN000142"
  );
  assert.equal(
    buildWorkerCode({
      nationality: "Myanmar",
      shirt_type: "Blue",
      shirt_number: "142",
    }),
    "MB000142"
  );
  assert.equal(
    buildWorkerCode({
      nationality: "Myanmar",
      shirt_type: "Green",
      shirt_number: "142",
    }),
    "MG000142"
  );
  assert.equal(
    buildWorkerCode({
      nationality: "Cambodia",
      shirt_type: "Blue",
      shirt_number: "142",
    }),
    "CB000142"
  );
  assert.equal(
    buildWorkerCode({
      nationality: "Cambodia",
      shirt_type: "Green",
      shirt_number: "142",
    }),
    "CG000142"
  );
});

test("buildWorkerCode pads shirt number to six digits", () => {
  assert.equal(
    buildWorkerCode({
      nationality: "Myanmar",
      shirt_type: "Navy",
      shirt_number: "4",
    }),
    "MN000004"
  );
  assert.equal(
    buildWorkerCode({
      nationality: "Myanmar",
      shirt_type: "Navy",
      shirt_number: "130",
    }),
    "MN000130"
  );
});

test("buildWorkerCode rejects unsupported nationality or shirt type", () => {
  assert.throws(
    () =>
      buildWorkerCode({
        nationality: "Thai",
        shirt_type: "Navy",
        shirt_number: "4",
      }),
    (error) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "INVALID_WORKER_CODE_PREFIX"
  );
  assert.throws(
    () =>
      buildWorkerCode({
        nationality: "Myanmar",
        shirt_type: "Red",
        shirt_number: "4",
      }),
    (error) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "INVALID_WORKER_CODE_PREFIX"
  );
});

test("buildWorkerCode rejects invalid shirt number", () => {
  for (const shirtNumber of ["A4", "1.5", "1e2", "1000000"]) {
    assert.throws(
      () =>
        buildWorkerCode({
          nationality: "Myanmar",
          shirt_type: "Navy",
          shirt_number: shirtNumber,
        }),
      (error) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "INVALID_SHIRT_NUMBER"
    );
  }
});
