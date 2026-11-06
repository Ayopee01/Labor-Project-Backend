// Import Library
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
// Import DB
import { getDatabaseCaCert, stripSslParams } from "../../../src/db/prisma";

/* -------------------------------------- Test Hooks -------------------------------------- */

afterEach(() => {
  delete process.env.DATABASE_CA_CERT;
});

/* -------------------------------------- Tests -------------------------------------- */

test("stripSslParams removes ssl* and uselibpqcompat but keeps other params", () => {
  const result = stripSslParams(
    "postgresql://user:p%40ss@db.example.com:25060/app?sslmode=require&sslrootcert=prisma/ca.crt&uselibpqcompat=true&connect_timeout=10"
  );

  assert.equal(
    result,
    "postgresql://user:p%40ss@db.example.com:25060/app?connect_timeout=10"
  );
});

test("stripSslParams leaves a URL without ssl params unchanged", () => {
  const url = "postgresql://user:pass@localhost:5433/labor_project";

  assert.equal(stripSslParams(url), url);
});

test("getDatabaseCaCert returns undefined when unset or blank", () => {
  assert.equal(getDatabaseCaCert(), undefined);

  process.env.DATABASE_CA_CERT = "   ";
  assert.equal(getDatabaseCaCert(), undefined);
});

test("getDatabaseCaCert converts escaped \\n into real newlines", () => {
  process.env.DATABASE_CA_CERT =
    "-----BEGIN CERTIFICATE-----\\nABC\\n-----END CERTIFICATE-----";

  assert.equal(
    getDatabaseCaCert(),
    "-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----"
  );
});

test("getDatabaseCaCert keeps multi-line PEM as is", () => {
  const pem = "-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----";
  process.env.DATABASE_CA_CERT = pem;

  assert.equal(getDatabaseCaCert(), pem);
});
