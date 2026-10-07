# Labor Project Backend

Backend API สำหรับระบบบริหารงานแรงงานลงสินค้า ครอบคลุมการรับงานจาก Gate, การจ่ายงานให้ Worker ผ่านคิว FIFO, การส่งยอดและยืนยันผลผ่าน LINE, การคำนวณค่าแรง และระบบจัดการฝั่ง Admin

## Tech Stack

- Node.js 22, TypeScript, Express
- PostgreSQL + Prisma ORM
- Redis + BullMQ
- WebSocket (Worker), SSE (Admin / Driver)
- LINE Messaging API, Firebase Cloud Messaging, DigitalOcean Spaces
- Docker Compose, GitHub Actions

## เอกสารประกอบ

| เอกสาร | รายละเอียด |
| --- | --- |
| Swagger UI | `/api-docs` (source: `src/docs/openapi`) |
| [Postman_Collection.json](Postman_Collection.json) | Collection สำหรับทดสอบ API |
| [docs/flow.md](docs/flow.md) | Flow การทำงานหลักของระบบ |
| [docs/Pattern.md](docs/Pattern.md) | มาตรฐานการเขียนโค้ด, comment และ import |
| [docs/deployment.md](docs/deployment.md) | การ Deploy, Logging, Firewall และ Secret checklist |
| [test/README.md](test/README.md) | รายละเอียดชุดทดสอบ |

## การติดตั้ง (Local Development)

```bash
npm install
cp .env.example .env
```

กำหนดค่า secret ใน `.env` ให้ครบ (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_LOGIN_CHALLENGE_SECRET`, `REFRESH_TOKEN_HASH_SECRET`)

เริ่ม PostgreSQL และ Redis:

```bash
docker compose --profile local-db up -d postgres redis
```

> Container `postgres` ใช้ host port `5434` ให้ตั้ง `POSTGRES_HOST_PORT=5433` ใน `.env` หรือแก้ port ใน `DATABASE_URL` ให้ตรงกัน
> หากใช้ PostgreSQL ที่ติดตั้งในเครื่อง ให้รันเฉพาะ Redis ด้วย `npm run docker:redis`

เตรียมฐานข้อมูลและเริ่ม server:

```bash
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

API ให้บริการที่ `http://localhost:8080` และ Swagger UI ที่ `http://localhost:8080/api-docs`

## คำสั่งที่ใช้บ่อย

| คำสั่ง | รายละเอียด |
| --- | --- |
| `npm run dev` | เริ่ม server โหมดพัฒนา |
| `npm run build` | Compile TypeScript ไปที่ `dist/` |
| `npm start` | รัน build ที่ compile แล้ว |
| `npm run db:migrate` | สร้างและ apply migration |
| `npm run db:deploy` | Apply migration บน production |
| `npm run db:seed` | ใส่ข้อมูลตั้งต้น (Admin และ Master data) |
| `npm test` | Unit test และ Route test |
| `npm run test:all` | ทดสอบทั้งหมด รวม Integration, Concurrency, E2E และ Realtime |

> ชุดทดสอบที่ต่อฐานข้อมูลจริงต้องใช้ `DATABASE_URL` ที่มีคำว่า `test` ในชื่อฐานข้อมูล

## โครงสร้างโปรเจกต์

```text
src/
  config/         ค่า configuration และ constant
  routes/         Express routes แยกตาม Swagger tag
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

Production และ environment สำหรับ dev/test ทำงานบน DigitalOcean Droplet ด้วย Docker Compose (profile `production`) และรองรับการ deploy อัตโนมัติจาก branch `main` ผ่าน GitHub Actions ดูขั้นตอนทั้งหมดที่ [docs/deployment.md](docs/deployment.md)
