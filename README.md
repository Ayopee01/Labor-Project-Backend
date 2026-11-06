# Labor Project Backend

Backend API สำหรับระบบบริหารงานแรงงานลงสินค้า ครอบคลุมการรับงานจาก Gate, การจ่ายงานให้ Worker ผ่านคิว FIFO, การส่งยอดและยืนยันผลผ่าน LINE, การคำนวณค่าแรง และระบบจัดการฝั่ง Admin

## Tech Stack

| Technology | Version | Role |
| --- | --- | --- |
| [Bun](https://bun.sh) | 1.4.4 | runtime และ package manager |
| [Node.js](https://nodejs.org) | 26.12.1 ([.nvmrc](.nvmrc)) | รัน Unit test และ Route test |
| [TypeScript](https://www.typescriptlang.org) | 7.0.2 | ภาษา |
| [Hono](https://hono.dev) | 4.13.18 | web framework |
| PostgreSQL | 16 | database |
| [Prisma](https://www.prisma.io) | 7.10.1 | ORM และ migration (config ที่ `prisma.config.ts`) |
| Redis | 7 | คิว Worker, presence และ backend ของ BullMQ |
| [BullMQ](https://bullmq.io) | 6.7.6 | background job (assignment timeout, break return, ส่งข้อความ LINE) |
| Docker | `oven/bun:1.4.4-alpine` | container สำหรับ deploy |
| GitHub Actions | - | CI (typecheck และ test ทุกชุด) |

## Libraries

| Library | Version | Purpose |
| --- | --- | --- |
| `@hono/node-server` | 2.1.8 | รัน Hono บน `node:http` |
| `@prisma/client`, `@prisma/adapter-pg` | 7.10.1 | Prisma client ต่อ PostgreSQL ผ่าน driver `pg` |
| `ioredis` | 6.0.0 | ต่อ Redis (คิว Worker และ connection ของ BullMQ) |
| `zod` | 4.6.7 | validate body, query และ payload ของ token |
| `jsonwebtoken` | 9.0.3 | เซ็น/ตรวจ JWT (HS256) |
| `argon2` | 0.45.2 | hash password (argon2id) |
| `p-queue` | 10.0.0 | จำกัดจำนวนงาน argon2 ที่รันพร้อมกัน |
| `ws` | 8.23.0 | WebSocket ของ Worker (`/ws/workers`) |
| `better-sse` | 0.16.1 | SSE ของ Admin (`/api/admin/events`) และ Driver (`/api/driver/jobs/stream`) |
| `@line/bot-sdk` | 11.4.0 | LINE Messaging API (push/reply Flex Message) |
| `firebase-admin` | 14.5.1 | Firebase Cloud Messaging (push notification ถึง Worker) |
| `@aws-sdk/client-s3` | 3.1169.0 | อัปโหลดรูปโปรไฟล์ขึ้น DigitalOcean Spaces |
| `@sentry/node` | 11.12.0 | error tracking |
| `pino` | 10.4.0 | log แบบ JSON |
| `date-fns`, `@date-fns/tz` | 4.4.0, 1.5.0 | คำนวณวันเวลาตามเขตเวลา Asia/Bangkok |
| `swagger-jsdoc` | 6.3.0 | รวม OpenAPI YAML ใน `src/docs/openapi` เป็น spec |
| `swagger-ui-dist` | 5.35.0 | เสิร์ฟ Swagger UI ที่ `/api-docs` |
| `dotenv` | 18.0.10 | โหลด `.env` |
| `tsx` (dev) | 4.23.15 | ให้ `node --test` รันไฟล์ TypeScript ได้ |

Version คือเวอร์ชันที่ล็อกไว้ใน `bun.lock` (ใน `package.json` เป็นช่วง `^`) Middleware ในตัวของ Hono ที่ใช้: `cors`, `combine`

## Documentation

| เอกสาร | รายละเอียด |
| --- | --- |
| Swagger UI | `/api-docs` (source: `src/docs/openapi`) |
| [Postman_Collection.json](Postman_Collection.json) | Collection สำหรับทดสอบ API |
| [docs/flow.md](docs/flow.md) | Flow การทำงานหลักของระบบ |
| [docs/Pattern.md](docs/Pattern.md) | มาตรฐานการเขียนโค้ด, comment และ import |
| [docs/deployment.md](docs/deployment.md) | การ Deploy, Logging, Firewall และ Secret checklist |
| [API Documentation](docs/API%20Documentation%20-%20Labor%20Project%20Backend.xlsx) | รายละเอียด Request/Response ของทุก API |
| [Data Dictionary](docs/Data%20Dictionary%20of%20Labor.docx) | โครงสร้างตารางในฐานข้อมูล |
| [test/README.md](test/README.md) | รายละเอียดชุดทดสอบ |

## Prerequisites

- [Bun](https://bun.sh) 1.4.4 สำหรับรัน server และจัดการ dependency
- Node.js ตาม [.nvmrc](.nvmrc) สำหรับ Unit test และ Route test เท่านั้น (mock module ผ่าน `Module._load` ซึ่งไม่ทำงานบน `bun test`)
- Docker สำหรับ PostgreSQL และ Redis

## Installation (Local Development)

```bash
bun install
cp .env.example .env
```

กำหนดค่า secret ใน `.env` ให้ครบ (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_LOGIN_CHALLENGE_SECRET`, `REFRESH_TOKEN_HASH_SECRET`)

เริ่ม PostgreSQL และ Redis:

```bash
docker compose --profile local-db up -d postgres redis
```

> Container `postgres` ใช้ host port `5434` ตรงกับ `DATABASE_URL` ใน `.env.example` (เปลี่ยนได้ด้วย `POSTGRES_HOST_PORT` แต่ต้องแก้ port ใน `DATABASE_URL` ให้ตรงกัน)
> หากใช้ PostgreSQL ที่ติดตั้งในเครื่อง ให้รันเฉพาะ Redis ด้วย `bun run docker:redis`

เตรียมฐานข้อมูลและเริ่ม server:

```bash
bun run db:generate
bun run db:migrate
bun run db:seed
bun run dev
```

API ให้บริการที่ `http://localhost:8080` และ Swagger UI ที่ `http://localhost:8080/api-docs`

## Common Commands

| คำสั่ง | รายละเอียด |
| --- | --- |
| `bun run dev` | เริ่ม server โหมดพัฒนา |
| `bun start` | เริ่ม server โดยไม่ watch (Bun รัน TypeScript โดยตรง ไม่มีขั้นตอน build) |
| `bun run typecheck` | ตรวจ TypeScript |
| `bun run db:migrate` | สร้างและ apply migration |
| `bun run db:deploy` | Apply migration บน production |
| `bun run db:seed` | ใส่ข้อมูลตั้งต้น (Admin และ Master data) |
| `bun run images:sync` | อัปโหลดรูป Worker ที่ยังไม่ได้อัปโหลดจาก DB ขึ้น Spaces |
| `bun run images:check` | ตรวจว่ารูปโปรไฟล์ครบ (เพิ่ม `--verify` เพื่อเช็กไฟล์บน Spaces จริง) |
| `bun run test` | Unit test และ Route test |
| `bun run test:all` | ทดสอบทั้งหมด รวม Integration, Concurrency, E2E และ Realtime |

> ชุดทดสอบที่ต่อฐานข้อมูลจริงต้องใช้ `DATABASE_URL` ที่มีคำว่า `test` ในชื่อฐานข้อมูล
>
> ห้ามรัน `bun test` ตรงๆ กับ Unit test หรือ Route test เพราะ mock ไม่ทำงาน และ Bun โหลด `.env` อัตโนมัติ จึงอาจต่อฐานข้อมูลจริง ให้ใช้คำสั่ง `bun run test` แทน

## Project Structure

```text
src/
  config/         ค่า configuration และ constant
  routes/         Hono routes แยกตาม Swagger tag
  services/       Business logic (shared/ สำหรับ logic ที่ใช้ร่วมกัน)
  repositories/   การเข้าถึงฐานข้อมูลผ่าน Prisma
  queues/         BullMQ, คิว Worker และ background job
  websockets/     WebSocket ของ Worker
  middlewares/    Auth, permission, logging และ error handling
  validation/     Zod schema และ parser
  types/          Type และ DTO
  docs/           OpenAPI (Swagger)
prisma/           Schema, migration และ seed
test/             Unit, route, integration, concurrency, e2e และ realtime tests
```

## Deployment

Production ทำงานบน DigitalOcean App Platform โดย deploy อัตโนมัติทุกครั้งที่ push ขึ้น branch `main` (build จาก `Dockerfile` และรัน migration ตอน container start) ดูรายละเอียดที่ [docs/deployment.md](docs/deployment.md)
