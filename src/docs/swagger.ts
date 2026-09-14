import type { Express, Request, Response } from "express";
import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";
import { toPascalCaseKey, toPascalCasePayload } from "../middlewares/api-case.middleware";

/* -------------------------------------- Functions -------------------------------------- */

// Function เรียง Swagger tags สำหรับ Swagger/OpenAPI
function sortSwaggerTags(firstTag: string, secondTag: string): number {
  const tagOrder: Record<string, number> = {
    System: 0,
    Auth: 1,
    "Admin Workers": 2,
    "Admin Jobs": 3,
    "Admin Audit": 4,
    "Admin Settings": 5,
    "Admin Realtime": 6,
    "Gate": 7,
    "Driver": 8,
    "Worker Application": 9,
    "LINE": 10,
  };
  const firstOrder = tagOrder[firstTag] ?? 999;
  const secondOrder = tagOrder[secondTag] ?? 999;

  return firstOrder - secondOrder || firstTag.localeCompare(secondTag);
}

// Function เรียง Swagger operations สำหรับ Swagger/OpenAPI
function sortSwaggerOperations(
  firstOperation: { get: (key: string) => string },
  secondOperation: { get: (key: string) => string }
): number {
  const operationOrder: Record<string, number> = {
    // System
    "get /ready": 0,
    // Auth
    "post /api/auth/login": 1,
    "post /api/auth/login/confirm-force": 2,
    "post /api/auth/refresh": 3,
    "post /api/auth/logout": 4,
    "post /api/auth/push-token": 5,
    "get /api/auth/me": 6,
    // Admin Workers
    "get /api/admin/users": 7,
    "get /api/admin/users/{workerCode}": 8,
    "post /api/admin/users": 9,
    "patch /api/admin/users/{workerCode}": 10,
    "patch /api/admin/users/{workerCode}/password": 11,
    // Admin Jobs
    "get /api/admin/jobs/workers/status": 12,
    "post /api/admin/jobs/workers/{workerCode}/status/force": 13,
    "post /api/admin/vehicle-jobs/assignment/cancel": 14,
    "get /api/admin/vehicle-jobs/operations": 15,
    "get /api/admin/vehicle-jobs/history": 16,
    "get /api/admin/vehicle-jobs/history/daily-worker-income": 17,
    "get /api/admin/vehicle-jobs/{ticketNumber}/financials": 18,
    "post /api/admin/vehicle-jobs/{ticketNumber}/assign-workers": 19,
    "post /api/admin/vehicle-jobs/{ticketNumber}/scan-deadline/extend": 20,
    "post /api/admin/vehicle-jobs/{ticketNumber}/tickets/{ticketNo}/stalls/{stallCode}/override-count": 21,
    "post /api/admin/vehicle-jobs/{ticketNumber}/wait": 22,
    "post /api/admin/vehicle-jobs/{ticketNumber}/release-workers": 23,
    // Admin Audit
    "get /api/admin/audit/workers/performance": 24,
    // Admin Settings
    "get /api/admin/settings": 25,
    "patch /api/admin/settings": 26,
    "get /api/admin/mobile-app-versions": 27,
    "post /api/admin/mobile-app-versions": 28,
    "patch /api/admin/mobile-app-versions/{id}": 29,
    "get /api/admin/roles": 30,
    "get /api/admin/users/{id}/permissions": 31,
    "patch /api/admin/users/{id}/permissions": 32,
    // Gate
    "get /api/gate/options": 33,
    "post /api/gate/tickets": 34,
    // Driver
    "post /api/driver/qr-sessions": 35,
    "get /api/driver/jobs/current": 36,
    "post /api/driver/jobs/{ticketNumber}/ready": 37,
    // Worker Application
    "get /api/workers/app-version/check": 38,
    "get /ws/workers": 39,
    "get /api/workers/me/status": 40,
    "get /api/workers/me/assignments/history": 41,
    "get /api/workers/me/earnings/summary": 42,
    "post /api/workers/me/online": 43,
    "post /api/workers/me/offline": 44,
    "post /api/workers/me/break": 45,
    "post /api/workers/me/assignments/{ticketNumber}/accept": 46,
    "post /api/workers/me/assignments/check-in-barcode": 47,
    "get /api/workers/me/products/{productCode}/packages": 48,
    "post /api/workers/me/assignments/tickets/complete": 49,
    "get /api/admin/events": 50,
    // Line
    "post /api/line/webhook": 51,
    "get /api/line/dev": 52,
    "get /api/line/dev/submissions": 53,
    "post /api/line/dev/submissions/{submissionId}/confirm": 54,
    "post /api/line/dev/submissions/{submissionId}/reject": 55,
  };
  const firstKey = `${firstOperation.get("method")} ${firstOperation.get("path")}`;
  const secondKey = `${secondOperation.get("method")} ${secondOperation.get("path")}`;
  const firstOrder = operationOrder[firstKey] ?? 999;
  const secondOrder = operationOrder[secondKey] ?? 999;

  return firstOrder - secondOrder || firstKey.localeCompare(secondKey);
}

const openapi = swaggerJsdoc({
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Backend API",
      version: "1.0.0",
    },
  },
  apis: [
    "./src/docs/openapi/system.yaml",
    "./src/docs/openapi/auth.yaml",
    "./src/docs/openapi/admin-workers.yaml",
    "./src/docs/openapi/admin-jobs.yaml",
    "./src/docs/openapi/admin-audit.yaml",
    "./src/docs/openapi/admin-settings.yaml",
    "./src/docs/openapi/gate.yaml",
    "./src/docs/openapi/driver.yaml",
    "./src/docs/openapi/worker.yaml",
    "./src/docs/openapi/notifications.yaml",
    "./src/docs/openapi/line.yaml",
    "./src/docs/openapi/components.yaml",
  ],
});

// Function ตรวจสอบ plain object ก่อนแปลง schema ของ OpenAPI แบบ recursive
function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// Config ข้อความ description ของ field ที่ต้องแสดงเป็น PascalCase ใน Swagger
const swaggerDescriptionReplacements: Array<[string, string]> = [
  ["access_token", "AccessToken"],
  ["refresh_token", "RefreshToken"],
  ["login_challenge_token", "LoginChallengeToken"],
  ["target_type", "TargetType"],
  ["driver_qr_token", "DriverQrToken"],
  ["qr_token", "QrToken"],
  ["client_id", "ClientId"],
  ["client_secret", "ClientSecret"],
  ["secret_hash", "SecretHash"],
  ["gate_transaction_ref", "GateTransactionRef"],
  ["assignment.created_at", "assignment.CreatedAt"],
  ["accept_deadline_at", "AcceptDeadlineAt"],
];

// Config acronym ในคำอธิบาย Swagger ที่ต้องคงรูปตัวพิมพ์ใหญ่
const swaggerAcronymDocTerms = new Map<string, string>([
  ["api", "API"],
  ["fcm", "FCM"],
  ["id", "ID"],
  ["qr", "QR"],
  ["sdk", "SDK"],
  ["sse", "SSE"],
  ["ui", "UI"],
]);

// Function แปลงคำอธิบาย EN ให้เป็น PascalCase และคงรูปตัวพิมพ์ใหญ่ของ acronym บางคำ โดยไม่แตะ path หรือ URL
function capitalizeSwaggerEnglishTerms(text: string): string {
  const protectedSegments: string[] = [];
  const pathOrUrlPattern = /https?:\/\/\S+|\/[A-Za-z0-9_{}:.-]+(?:\/[A-Za-z0-9_{}:.-]+)*/g;
  const protectedText = text.replace(pathOrUrlPattern, (segment) => {
    const placeholder = `__SWAGGER_DOC_SEGMENT_${protectedSegments.length}__`;
    protectedSegments.push(segment);

    return placeholder;
  });

  return protectedText
    .replace(/\b[a-z][a-z0-9-]*\b/g, (word) => {
      const acronym = swaggerAcronymDocTerms.get(word);

      return acronym ?? word[0].toUpperCase() + word.slice(1);
    })
    .replace(
      /__SWAGGER_DOC_SEGMENT_(\d+)__/g,
      (_placeholder, index) => protectedSegments[Number(index)]
    );
}

// Function เขียน description บาง schema ใหม่ให้ Swagger ตรงกับ contract PascalCase
function transformDescriptionText(description: string): string {
  const replacedDescription = swaggerDescriptionReplacements.reduce(
    (nextDescription, [from, to]) => nextDescription.split(from).join(to),
    description
  );

  return capitalizeSwaggerEnglishTerms(replacedDescription);
}

// Function แปลงชื่อ property ใน OpenAPI schema เป็น PascalCase แบบ recursive สำหรับ docs
function transformSchemaKeys(schema: unknown, seen = new Set<unknown>()): void {
  if (Array.isArray(schema)) {
    for (const entry of schema) {
      transformSchemaKeys(entry, seen);
    }

    return;
  }

  if (!isObject(schema) || seen.has(schema)) {
    return;
  }

  seen.add(schema);

  if (typeof schema.summary === "string") {
    schema.summary = capitalizeSwaggerEnglishTerms(schema.summary);
  }

  if (typeof schema.description === "string") {
    schema.description = transformDescriptionText(schema.description);
  }

  if (Array.isArray(schema.required)) {
    schema.required = schema.required.map((key) =>
      typeof key === "string" ? toPascalCaseKey(key) : key
    );
  }

  if (isObject(schema.properties)) {
    const transformedProperties: Record<string, unknown> = {};

    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      transformedProperties[toPascalCaseKey(key)] = propertySchema;
      transformSchemaKeys(propertySchema, seen);
    }

    schema.properties = transformedProperties;
  }

  if ("example" in schema) {
    schema.example = toPascalCasePayload(schema.example);
  }

  for (const [key, value] of Object.entries(schema)) {
    if (
      key === "properties" ||
      key === "required" ||
      key === "example" ||
      key === "summary" ||
      key === "description"
    ) {
      continue;
    }

    transformSchemaKeys(value, seen);
  }
}

// Config schema ของ response ทุกจุดใน spec ที่ต้องมี server_time และ server_time_unix_ms
const SERVER_TIME_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    server_time: {
      type: "string",
      format: "date-time",
      description: "current server time (ISO 8601), present on every response.",
    },
    server_time_unix_ms: {
      type: "integer",
      description: "current server time in epoch milliseconds, present on every response.",
    },
  },
};

// Function แนบ server_time และ server_time_unix_ms เข้าทุก response schema ใน spec แบบ recursive โดยไม่ต้องแก้ทีละไฟล์ YAML
function addServerTimeToResponseSchemas(spec: Record<string, unknown>): void {
  const paths = spec.paths;

  if (!isObject(paths)) {
    return;
  }

  for (const pathItem of Object.values(paths)) {
    if (!isObject(pathItem)) {
      continue;
    }

    for (const operation of Object.values(pathItem)) {
      if (!isObject(operation) || !isObject(operation.responses)) {
        continue;
      }

      for (const response of Object.values(operation.responses)) {
        if (!isObject(response) || !isObject(response.content)) {
          continue;
        }

        const jsonContent = response.content["application/json"];

        if (!isObject(jsonContent) || !("schema" in jsonContent)) {
          continue;
        }

        jsonContent.schema = {
          allOf: [jsonContent.schema, SERVER_TIME_RESPONSE_SCHEMA],
        };
      }
    }
  }
}

// Config header parameter ของ log/observability ที่ต้องแนบเข้าทุก operation ใน spec
const OBSERVABILITY_HEADER_PARAMETERS = [
  { $ref: "#/components/parameters/RequestIdHeader" },
  { $ref: "#/components/parameters/ClientTypeHeader" },
  { $ref: "#/components/parameters/ClientVersionHeader" },
];

// Function แนบ header parameter ของ log/observability เข้าทุก operation ใน spec แบบ recursive โดยไม่ต้องแก้ทีละไฟล์ YAML
function addObservabilityHeaderParameters(spec: Record<string, unknown>): void {
  const paths = spec.paths;

  if (!isObject(paths)) {
    return;
  }

  for (const pathItem of Object.values(paths)) {
    if (!isObject(pathItem)) {
      continue;
    }

    for (const operation of Object.values(pathItem)) {
      if (!isObject(operation)) {
        continue;
      }

      const existingParameters = Array.isArray(operation.parameters)
        ? operation.parameters
        : [];

      operation.parameters = [...existingParameters, ...OBSERVABILITY_HEADER_PARAMETERS];
    }
  }
}

// Function สร้าง external open API spec สำหรับ Swagger/OpenAPI
function buildExternalOpenApiSpec(): Record<string, unknown> {
  const externalOpenapi = JSON.parse(JSON.stringify(openapi)) as Record<string, unknown>;
  addServerTimeToResponseSchemas(externalOpenapi);
  addObservabilityHeaderParameters(externalOpenapi);
  transformSchemaKeys(externalOpenapi);

  return externalOpenapi;
}

const externalOpenapi = buildExternalOpenApiSpec();

// Function ตั้งค่า Swagger สำหรับ Swagger/OpenAPI
export default function setupSwagger(app: Express): void {
  app.get("/api-docs/openapi.json", (_req: Request, res: Response) => {
    res.json(externalOpenapi);
  });

  app.use(
    "/api-docs",
    swaggerUi.serve,
    swaggerUi.setup(null, {
      customSiteTitle: "Backend API Docs",
      // ขยายคอลัมน์ Name ของตาราง Parameters ให้กว้างพอ กันชื่อ header ยาวๆ เช่น X-Request-Id ตัดคำแล้วขึ้นบรรทัดใหม่แบบเพี้ยน
      customCss: `
        .swagger-ui .parameters-col_name { width: 260px; min-width: 220px; }
        .swagger-ui .parameters-col_name .parameter__name { word-break: normal; white-space: normal; }
      `,
      swaggerOptions: {
        url: "/api-docs/openapi.json",
        tagsSorter: sortSwaggerTags,
        operationsSorter: sortSwaggerOperations,
      },
    })
  );
}
