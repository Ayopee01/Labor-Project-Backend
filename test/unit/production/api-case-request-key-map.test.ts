// Import Library
import assert from "node:assert/strict";
import test from "node:test";
// Import Middlewares
import { normalizeApiRequestPayload, toPascalCaseKey } from "../../../src/middlewares/api-case.middleware";
// Import Validation
import * as schemas from "../../../src/validation/schemas";

// ทุก field ของ *BodySchema แปลงเป็น PascalCase แล้วแปลงกลับต้องได้ key เดิม (จับ requestKeyMap ที่ขาด)

// Schema ที่ไม่ผ่านการแปลง key (Gate รับ PascalCase ตรงๆ)
const SCHEMAS_EXEMPT_FROM_CASE_NORMALIZATION = new Set(["boothJobJobBodySchema"]);

// Function รวบรวมชื่อ field ของทุก *BodySchema
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
