// Import Library
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

/* -------------------------------------- Config -------------------------------------- */

// Config Prisma CLI (schema, คำสั่ง seed และ URL ของ DB)
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    seed: "bun prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
