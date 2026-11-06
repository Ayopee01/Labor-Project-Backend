# Labor Project Backend

Backend API สำหรับระบบบริหารงานแรงงานลงสินค้า ครอบคลุมการรับงานจาก Gate, การจ่ายงานให้ Worker ผ่านคิว FIFO, การส่งยอดและยืนยันผลผ่าน LINE, การคำนวณค่าแรง และระบบจัดการฝั่ง Admin

## Tech Stack

- Bun 1.4, TypeScript, Hono
- PostgreSQL + Prisma ORM
- Redis + BullMQ
- WebSocket (Worker), SSE (Admin / Driver)
- LINE Messaging API, Firebase Cloud Messaging, DigitalOcean Spaces
- Docker Compose, GitHub Actions

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

> Container `postgres` ใช้ host port `5434` ให้ตั้ง `POSTGRES_HOST_PORT=5433` ใน `.env` หรือแก้ port ใน `DATABASE_URL` ให้ตรงกัน
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
