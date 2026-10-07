// Import Library
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
// Import Docs
import setupSwagger from "../../../src/docs/swagger";

/* -------------------------------------- Helpers -------------------------------------- */

// Function สร้าง app ที่มีแค่ Swagger ตาม env ที่ตั้งไว้ แล้วยิง GET /api-docs/openapi.json
async function requestOpenApiJson(env: Record<string, string | undefined>, authorization?: string): Promise<number> {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  // process.env = undefined จะกลายเป็น string "undefined" จึงต้อง delete แทน
  const applyEnv = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };

  applyEnv(env);
  const app = express();
  setupSwagger(app);
  applyEnv(previous);

  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api-docs/openapi.json`, {
      headers: authorization ? { authorization } : {},
    });
    return response.status;
  } finally {
    server.close();
  }
}

// Function สร้าง header Basic auth
function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/* -------------------------------------- Tests -------------------------------------- */

const credentials = { API_DOCS_USERNAME: "docs-user", API_DOCS_PASSWORD: "docs-pass", NODE_ENV: "production" };

test("api docs require basic auth when credentials are configured", async () => {
  assert.equal(await requestOpenApiJson(credentials), 401);
  assert.equal(await requestOpenApiJson(credentials, basic("docs-user", "wrong")), 401);
  assert.equal(await requestOpenApiJson(credentials, basic("wrong", "docs-pass")), 401);
  assert.equal(await requestOpenApiJson(credentials, basic("docs-user", "docs-pass")), 200);
});

test("api docs are disabled in production when credentials are not configured", async () => {
  const env = { API_DOCS_USERNAME: undefined, API_DOCS_PASSWORD: undefined, NODE_ENV: "production" };

  assert.equal(await requestOpenApiJson(env), 404);
});

test("api docs stay open outside production when credentials are not configured", async () => {
  const env = { API_DOCS_USERNAME: undefined, API_DOCS_PASSWORD: undefined, NODE_ENV: "development" };

  assert.equal(await requestOpenApiJson(env), 200);
});
