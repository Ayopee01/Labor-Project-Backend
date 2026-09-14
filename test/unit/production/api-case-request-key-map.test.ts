import assert from "node:assert/strict";
import test from "node:test";

import { normalizeApiRequestPayload, toPascalCaseKey } from "../../../src/middlewares/api-case.middleware";
import * as schemas from "../../../src/validation/schemas";

// api-case.middleware.ts แปลง Key จาก PascalCase (Public API) กลับเป็น Internal Key (มักเป็น
// snake_case) ผ่าน requestKeyMap ที่ดูแลด้วยมือ — ถ้า Field ใหม่หลายคำถูกเพิ่มเข้า *BodySchema แล้ว
// ไม่ได้เพิ่มลง requestKeyMap ด้วย Field นั้นจะถูกเดา Key ผิดแบบเงียบๆ (Fallback ปัจจุบันแค่ lowerFirst
// ตัวแรก ไม่ได้ Split คำ) กลายเป็น undefined ที่ฝั่ง Service โดยไม่มี Error เตือนเลย (ดู BUG-018) — Test
// นี้แปลงทุก Field ของทุก *BodySchema เป็น PascalCase ตามที่ Client ต้องส่งจริง แล้วยิงกลับผ่าน
// normalizeApiRequestPayload (Pipeline เดียวกับที่ normalizeApiRequestBody Middleware ใช้จริง) ต้องได้
// Key เดิมกลับมาเป๊ะ ถ้าไม่ตรงแปลว่า requestKeyMap ขาด Entry ของ Field นั้น

// Schema ของ Endpoint ที่ normalizeApiRequestBody ตั้งใจข้ามไปเลย (ดู isBoothJobRequest ใน
// api-case.middleware.ts) — POST /api/gate/tickets รับ Body เป็น PascalCase ตรงๆ จาก Gate Vendor โดย
// ไม่ผ่าน requestKeyMap เลย จึงไม่ต้อง (และไม่ควร) เช็ค Round-trip ของ Schema นี้
const SCHEMAS_EXEMPT_FROM_CASE_NORMALIZATION = new Set(["boothJobJobBodySchema"]);

function collectBodySchemaFieldNames(): Map<string, string[]> {
  const fieldNamesBySchema = new Map<string, string[]>();

  for (const [exportName, schema] of Object.entries(schemas)) {
    if (
      !exportName.endsWith("BodySchema") ||
      SCHEMAS_EXEMPT_FROM_CASE_NORMALIZATION.has(exportName)
    ) {
      continue;
    }

    const shape = (schema as { shape?: Record<string, unknown> })?.shape;

    if (!shape) {
      continue;
    }

    fieldNamesBySchema.set(exportName, Object.keys(shape));
  }

  return fieldNamesBySchema;
}

test("every field declared in a *BodySchema round-trips correctly through requestKeyMap (api-case.middleware.ts) — catches a new multi-word field added without a matching map entry", () => {
  const fieldNamesBySchema = collectBodySchemaFieldNames();
  const failures: string[] = [];

  for (const [schemaName, fieldNames] of fieldNamesBySchema) {
    for (const fieldName of fieldNames) {
      const pascalKey = toPascalCaseKey(fieldName);
      const roundTripped = normalizeApiRequestPayload({ [pascalKey]: true }) as Record<
        string,
        unknown
      >;
      const resultKeys = Object.keys(roundTripped);

      if (resultKeys.length !== 1 || resultKeys[0] !== fieldName) {
        failures.push(
          `${schemaName}.${fieldName} -> PascalCase "${pascalKey}" -> "${resultKeys[0] ?? "(missing)"}" (expected "${fieldName}"). Add "${pascalKey}": "${fieldName}" to requestKeyMap in src/middlewares/api-case.middleware.ts.`,
        );
      }
    }
  }

  assert.deepEqual(
    failures,
    [],
    `Fields missing/incorrect in requestKeyMap:\n${failures.join("\n")}`,
  );
});
