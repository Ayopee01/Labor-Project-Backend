# Project Coding Pattern

เอกสารนี้ใช้เป็นแนวทางให้ AI Agent หรือผู้พัฒนาคนถัดไปเขียนโค้ดให้เข้ากับ pattern ของ project นี้

## วิธีวิเคราะห์ก่อนแก้โค้ด

1. อ่านไฟล์ที่เกี่ยวข้องก่อนแก้เสมอ อย่าแก้จากชื่อไฟล์อย่างเดียว
2. ดูว่า logic ควรอยู่ layer ไหนก่อนเพิ่มโค้ดใหม่
3. ถ้ามี helper เดิมใน project ให้ใช้ของเดิมเมื่อช่วยให้ flow ชัดขึ้น ไม่ใช้ helper แค่เพราะลดโค้ดซ้ำ
4. ถ้า type ใช้แค่ใน schema และไม่มีใคร import ไม่ต้องแยก type เพิ่ม
5. ถ้า config ใช้หลายไฟล์หรืออ่านจาก `.env` ให้แยกไว้ใน `src/config`
6. ถ้า literal หรือ logic สั้น ๆ อ่านง่ายเมื่ออยู่ตรงจุดใช้งาน ให้ inline ได้แม้ใช้หลายครั้ง เช่น `"Bearer"` หรือ `try/catch`
7. แยก constant/helper เฉพาะเมื่อช่วยอธิบาย business meaning, ลดความซับซ้อนจริง, หรือเป็น config/shared logic หลายไฟล์
8. หลังแก้ logic หรือ type ให้รัน `npm run build`
9. ถ้าแก้ behavior ให้รัน `npm test`

## โครงสร้าง Layer

Dependency & Ownership Rules:

- TicketJob (vehicle job) lifecycle orchestration belongs in `services/shared/ticket-job-lifecycle.service.ts`. Repositories may expose low-level state reads/writes, but should not own multi-domain lifecycle decisions such as activating the next ticket or closing a completed vehicle job.
- Hot summary endpoints should use DB aggregate/count queries instead of loading full detail/history when only totals are required. Keep full detail loading for detail/history endpoints.
- Route repositories should not re-export shared repositories as compatibility or convenience facades. Import the repository that owns the data access directly.
- Shared services should not depend on route/application-specific repositories. If a shared service needs persisted data, use the shared repository that owns that entity, or let the route/application service compose the route-specific projection outside the shared service.
- Repository mutation ownership should follow the persisted entity being changed. For example, `VehicleJobAssignment` state mutations belong in the vehicle job assignment repository, while vehicle job lifecycle orchestration belongs in the shared lifecycle service.
- Important raw SQL read models should have real DB integration coverage. Route tests with mocked repositories can validate API contract and service wiring, but they do not prove SQL syntax, CTE scope, pagination, or database aggregate semantics.
- `services/` = route/application services
- `services/shared/` = shared business service / orchestration ที่ไม่มี route ของตัวเอง หรือ reuse หลาย flow
- `repositories/` = route/application-specific data access หรือ read model/projection เฉพาะ route นั้น
- `repositories/shared/` = reusable/shared domain data access ที่ถูกใช้ได้หลาย service, route, queue หรือ shared orchestration
- Shared repository ไม่จำเป็นต้องมี Route คู่กัน และไม่ควรถูก re-export ผ่าน route repository เพียงเพื่อ compatibility
- `utils/` = pure/helper/formatter/deterministic logic
- `types/shared/` = reusable domain types/constants
- Direction หลัก: `Route -> Application Service -> Shared Service -> Repository / Integration -> DB`
- Pure Utils ถูกเรียกจาก layer ด้านบนได้ แต่ Utils ไม่ควร import Application Service
- Ticket Completion, Ticket Financialization, Worker Attendance, Worker Push, Realtime Notification, Runtime Settings, และ Account Permission เป็น shared service เพราะไม่มี route ของตัวเอง หรือถูก reuse หลาย flow
- WorkerAssignmentEvent เป็น Assignment domain concept ไม่ใช่ Admin Audit concept: type อยู่ที่ `types/shared/worker-assignment-event.type.ts` และ write repository อยู่ที่ `repositories/shared/worker-assignment-event.repository.ts`
- Admin Audit repository query persisted facts เท่านั้น ส่วน historical timeout classification อยู่ใน Admin Audit service
- Worker/Queue/Driver/Admin Jobs ต้อง import runtime settings จาก `services/shared/runtime-settings.service.ts`
- Auth/Admin Settings ต้อง import account permission resolution จาก `services/shared/account-permission.service.ts`
- Multi-transport realtime orchestration ต้องอยู่ที่ `services/shared/realtime-notification.service.ts`; `notifications.service.ts` ดูแล Admin SSE และ `worker.socket.ts` ดูแล Worker WebSocket

### routes

Route มีหน้าที่รับ request และส่งต่อให้ service เท่านั้น

- ไม่ใส่ business logic ใน route
- ไม่ query database ใน route
- เขียน `try/catch` inline ในแต่ละ route แล้วส่ง error ไปที่ `next(error)`
- ไม่ต้องแยก wrapper/helper เช่น `asyncHandler` ถ้าทำให้ต้องอ่านข้ามไฟล์เพื่อเข้าใจ flow ของ route
- ส่ง `req.body`, `req.query`, `req.params`, `req.auth` ไปให้ service ตามจำเป็น

ตัวอย่าง pattern ที่ OK:

```ts
router.post("/", async (req, res, next) => {
  try {
    const result = await userService.createUser(req.body, req.auth);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});
```

### services

Service เป็น logic หลักของ feature

- validate input ผ่าน `parseWithSchema` หรือ parser เฉพาะทาง
- ตรวจ business rule เช่น duplicate username, inactive account, force login
- เรียก repository เพื่ออ่าน/เขียน database
- รวม response shape ที่ API ต้องส่งกลับ
- ใช้ `withTransaction` เมื่อมีการเขียนหลาย table ใน workflow เดียว
- โยน error ด้วย `ApiError`
- ถ้า logic เป็น background worker, Redis queue, BullMQ processor, หรือ dispatch queue ที่ไม่ได้ผูกกับ route เดียว ให้วางใน `src/queues` แล้วให้ service เรียกใช้ตามจำเป็น

ตัวอย่าง comment:

```ts
// Function สร้าง user พร้อม profile และ schedule เริ่มต้น
export async function createUser(body: unknown, auth?: AccessTokenPayload) {
  ...
}
```

### repositories

Repository เป็นชั้นติดต่อ database ผ่าน Prisma

- 1 repository ควรอิง table หลักหรือกลุ่ม query ของ table นั้น
- ไม่ใส่ business rule ของ API ใน repository
- รับ `connection?: DbConnection` เพื่อใช้ได้ทั้ง Prisma client ปกติและ transaction client
- แปลง Prisma record เป็น DTO ผ่าน mapper
- ถ้าต้องสร้าง Prisma `where` หรือ `data` ที่ซับซ้อน ให้แยก helper ในไฟล์เดียวกัน

ตัวอย่าง pattern ที่ OK:

```ts
// Function เลือก prisma client ปกติ หรือ transaction client ที่ส่งเข้ามา
function client(connection?: DbConnection): DbConnection {
  return connection ?? prisma;
}
```

### mapper

Mapper มีหน้าที่แปลง field จาก Prisma model เป็น DTO ที่ project ใช้

- แปลง camelCase จาก Prisma เป็น snake_case ใน DTO
- ตัดข้อมูล sensitive เช่น `password_hash` ด้วย `sanitizeAccount`
- ไม่ใส่ query หรือ business logic

### validation

Validation ใช้ Zod เป็นหลัก

- `schemas.ts` เก็บ schema และ format พื้นฐาน
- `parser.ts` เก็บ function parse และแปลง error เป็น `ApiError`
- ถ้ามี error code เฉพาะ เช่น `INVALID_SHIFT_TIME` ให้แยก parser เฉพาะทางได้
- ไม่จำเป็นต้องสร้าง type จาก `z.infer` ถ้าไม่มีการ import ใช้งานจริง

ตัวอย่าง comment:

```ts
// Schema body สำหรับเข้าสู่ระบบด้วย username/password และข้อมูลอุปกรณ์
export const loginBodySchema = z.object({
  ...
});
```

### types

Types แยกตาม route/tag/feature ที่เรียกใช้จริง

- `auth.type.ts` สำหรับ token, session, auth response
- `admin-workers.type.ts` สำหรับ worker account DTO, profile DTO, work schedule DTO, admin worker response
- `admin-jobs.type.ts` สำหรับ filter/result ของงานฝั่ง Admin Jobs
- `admin-settings.type.ts` สำหรับ runtime setting และ permission response
- `worker.type.ts` สำหรับ worker queue, assignment, ticket, vehicle/market job DTO
- `driver.type.ts` สำหรับ driver session DTO/response
- `gate.type.ts` สำหรับ Gate payload และ Gate response
- `line.type.ts` สำหรับ LINE webhook/event/queue payload
- `notifications.type.ts` สำหรับ SSE notification event/client
- `common.type.ts` สำหรับ type กลาง เช่น DB connection, error response, parser option
- `express.d.ts` สำหรับ extend `Express.Request`
- ไม่สร้าง type เผื่อไว้ถ้ายังไม่มีคนใช้
- Project นี้เลือกให้ type ที่ใช้จริงรวมไว้ใน `src/types` เพื่อให้ค้นหา shape ได้จากจุดเดียว แม้บาง type จะมาจาก body/query ที่ parse ด้วย Zod

ตัวอย่าง comment:

```ts
// Type ส่วน Response ของ API auth login / confirm-force-login
export interface AuthSuccessResponse {
  ...
}
```

### utils

Utils ใช้สำหรับ logic ที่ reusable หรือแยกแล้วช่วยให้อ่านง่ายขึ้น

- ใช้กับ logic ที่มีโอกาสเรียกซ้ำ เช่น JWT, password, refresh token hash, shift
- ถ้า helper ใช้แค่ไฟล์เดียวและทำให้ตาม code ยากขึ้น ให้เก็บไว้ในไฟล์นั้น
- Utils ไม่ควรรู้ business flow ของ service มากเกินไป

### config

Config ใช้กับค่าที่เป็น configuration จริง

- ค่า default ที่ใช้หลายไฟล์ ให้วางใน `src/config`
- ค่าที่อ่านจาก `.env` และใช้หลายจุด ให้วางใน `src/config`
- ค่าเฉพาะไฟล์เดียว เช่น role filter ใน repository วางในไฟล์นั้นได้

ตัวอย่าง comment:

```ts
// Config ค่า default ของ token และ session ในระบบ auth
export const AUTH_DEFAULTS = {
  ...
} as const;
```

## Import Pattern

### ลำดับกลุ่ม import

แบ่ง import เป็นกลุ่มตามโฟลเดอร์ต้นทาง และใส่ comment `// Import <กลุ่ม>` นำหน้าทุกกลุ่ม เรียงจากบนลงล่างดังนี้ (ข้ามกลุ่มที่ไม่มี):

| ลำดับ | Comment | import จาก |
| --- | --- | --- |
| 1 | `// Import Library` | package ภายนอก และ `node:*` เช่น `express`, `zod`, `@prisma/client`, `node:crypto` |
| 2 | `// Import Config` | `src/config`, `src/constants`, `src/db` |
| 3 | `// Import Middlewares` | `src/middlewares` |
| 4 | `// Import Routes` | `src/routes` |
| 5 | `// Import Repositories` | `src/repositories` (รวม `shared`) |
| 6 | `// Import Mappers` | `src/repositories/shared/mappers` |
| 7 | `// Import Services` | `src/services` (รวม `shared`) |
| 8 | `// Import Queues` | `src/queues` |
| 9 | `// Import Websockets` | `src/websockets` |
| 10 | `// Import Runtime` | `src/runtime` |
| 11 | `// Import Docs` | `src/docs` |
| 12 | `// Import Types` | `src/types` (`import type` จาก library ให้อยู่กลุ่ม Library) |
| 13 | `// Import Validation` | `src/validation` |
| 14 | `// Import Utils` | `src/utils` |
| 15 | `// Import Helpers` | เฉพาะ test: `test/helpers`, `test/setup` |
| 16 | `// Import Seeds` | เฉพาะ prisma: seed file อื่นใน `prisma/` |

กติกา:

- ชื่อกลุ่มขึ้นต้นด้วย `Import` ตัว I ใหญ่ ตามด้วยชื่อกลุ่มจากตารางเท่านั้น ห้ามเขียนเป็นประโยค เช่น `// Import real repository for ...`
- ใช้ `Middlewares` (มี s) ให้ตรงกับชื่อโฟลเดอร์
- ไม่เว้นบรรทัดว่างระหว่างกลุ่ม ให้ comment ของกลุ่มถัดไปต่อจาก import บรรทัดสุดท้ายของกลุ่มก่อนหน้าทันที
- เว้นบรรทัดว่าง 1 บรรทัดหลัง import กลุ่มสุดท้าย ก่อนเริ่มโค้ด
- import หลายตัวจาก module เดียวกันให้รวมเป็นบรรทัดเดียว ห้าม import module เดิมซ้ำหลายบรรทัด
- `import type` จาก module เดียวกับ value import แยกบรรทัดได้ แต่ให้อยู่ติดกันในกลุ่มเดียวกัน
- ถ้าไฟล์มี import กลุ่มเดียว ยังต้องใส่ comment กลุ่มนั้น
- ใน test ห้ามสลับลำดับ import ที่มี side effect เช่น `../setup/test-env` หรือ harness ที่ต้อง patch module ก่อนโหลด ให้เติมแค่ comment กลุ่มตามตำแหน่งเดิม
- ค่าคงที่หรือโค้ดอื่นห้ามแทรกระหว่าง import ให้ย้ายไปไว้ใต้ section ที่เหมาะสม เช่น `Config`

### import ต้องอยู่บรรทัดเดียว

Named import และ `import type` ให้เขียนบรรทัดเดียวเสมอ แม้จะยาวก็ตาม ห้ามแตกรายชื่อขึ้นหลายบรรทัด:

```ts
// ถูก
import { ACTIVE_ASSIGNMENT_STATUSES, SHIRT_COLOR_SNAPSHOT, TERMINAL_JOB_STATUSES, TICKET_STATUS } from "../constants/status";

// ผิด
import {
  ACTIVE_ASSIGNMENT_STATUSES,
  SHIRT_COLOR_SNAPSHOT,
} from "../constants/status";
```

### ตัวอย่างเต็ม

```ts
// Import Library
import express from "express";
// Import Config
import { ADMIN_PERMISSIONS } from "../config/permission.config";
// Import Middlewares
import authMiddleware from "../middlewares/auth.middleware";
// Import Repositories
import * as adminJobsRepository from "../repositories/admin-jobs.repository";
// Import Services
import * as ticketCompletionService from "./shared/ticket-completion.service";
// Import Types
import type { DbConnection } from "../types/common.type";
// Import Validation
import { parseWithSchema } from "../validation/parser";
// Import Utils
import { ApiError } from "../utils/api-error";

/* -------------------------------------- Functions -------------------------------------- */
```

## Section Comment Pattern

ใช้ section divider แบ่งไฟล์ตามกลุ่มหน้าที่ เมื่อไฟล์มีมากกว่าหนึ่งกลุ่ม เช่นมีทั้ง config และ function:

```ts
/* -------------------------------------- Config -------------------------------------- */

/* -------------------------------------- Functions -------------------------------------- */
```

รูปแบบ:

- ขึ้นต้นด้วย `/* ` ตามด้วยขีด `-` 38 ตัว เว้นวรรค ชื่อ section เว้นวรรค ขีด `-` 38 ตัว แล้วปิดด้วย ` */`
- ชื่อ section เป็นภาษาอังกฤษ ขึ้นต้นตัวใหญ่ทุกคำ (Title Case) สั้น 1-4 คำ และสะกดให้ถูก
- เว้นบรรทัดว่าง 1 บรรทัดก่อนและหลัง divider
- divider แรกอยู่ถัดจาก import กลุ่มสุดท้าย (เว้น 1 บรรทัด)
- ไม่ใส่ divider ในไฟล์ที่มีแค่กลุ่มเดียวและสั้น

ชื่อ section มาตรฐาน (เรียงตามลำดับที่มักอยู่ในไฟล์):

| Section | ใช้กับ |
| --- | --- |
| `Types` | type/interface ที่ใช้เฉพาะในไฟล์ |
| `Config` | constant/config ที่ควบคุม behavior |
| `Formats` | Zod format ชิ้นเล็กที่ reuse |
| `Common Schemas`, `Auth Schemas`, `User Schemas`, `Query Schemas`, `Token Schemas` | Zod schema แยกตาม domain |
| `Error Helpers` | helper สร้าง/แปลง error |
| `Parsers` | function parse input |
| `Helpers` | function ภายในไฟล์ที่ไม่ export |
| `Functions` | function หลักของไฟล์ |
| `Mock Data`, `Master Data` | ข้อมูลใน seed |

ใน test ใช้ชื่อเพิ่มเติมได้ เช่น `Test Env`, `Setup`, `Module Loader Patch`, `Test Helpers`, `Test Lifecycle`, `Tests` และชื่อกลุ่ม test ตาม feature เช่น `Gate Route Tests`, `Worker Queue Route Tests`

ถ้าไฟล์ใหญ่มีหลาย feature (เช่น repository ที่มีหลายรายงาน) ใช้ชื่อ feature เป็นชื่อ section ได้ เช่น `Daily Stall Fee`, `Monthly Stall Fee`

## Comment Pattern

Comment ของ project นี้ใช้ภาษาไทย สั้น ชัด บรรทัดเดียว และขึ้นต้นด้วยชนิดของสิ่งนั้นเป็นภาษาอังกฤษ (`Function`, `Config`, `Format`, `Schema`, `Type`, `Mock`) คำเทคนิค ชื่อ field ชื่อ status ชื่อ table และ error code เขียนเป็นภาษาอังกฤษตามโค้ดได้

### หลักการรวม

1. **Comment นำหน้า declaration ต้องมีบรรทัดเดียวเท่านั้น** บอกว่าสิ่งนั้น "ทำอะไร" ไม่ใช่เล่าว่า "ทำไปเพราะอะไร"
2. **ความยาวเป้าหมายไม่เกินประมาณ 100 ตัวอักษร** ถ้ายาวกว่านั้นให้ตัดรายละเอียดออก ไม่ใช่ขึ้นบรรทัดใหม่
3. **Comment ภายใน function ใส่เฉพาะเมื่อจำเป็นจริง** เช่น business rule ที่อ่านจากโค้ดแล้วไม่เข้าใจ, invariant, race condition, สูตรคำนวณเงิน ใช้บรรทัดเดียวเป็นหลัก ไม่เกิน 2 บรรทัด
4. **ห้าม comment ที่แค่อ่านโค้ดซ้ำ** เช่น `// loop ทุก worker` เหนือ `for (const worker of workers)`
5. **ห้ามอ้างอิงสิ่งที่ล้าสมัยหรือหาไม่เจอ** เช่น เลขบรรทัด (`บรรทัด ~266`), ชื่อ bug/ticket (`BUG-001`, `Fix B`, `Phase 3`), เลขข้อ spec (`27.14.2`), ประวัติการแก้ (`เดิม...`, `ย้ายมาจาก...`, `...อีกต่อไป`), บทสนทนา (`ตัวอย่างที่คุยกัน`)
6. **ห้ามคำฟุ่มเฟือยที่ไม่ให้ข้อมูล** เช่น `สำหรับ helper กลาง`, `ใน service flow`, `สำหรับ test` (เมื่ออยู่ในไฟล์ test อยู่แล้ว) และหลีกเลี่ยง `จัดการ ...` ให้ใช้กริยาที่เจาะจง เช่น สร้าง / ดึง / ตรวจ / ยกเลิก / แปลง / ส่ง
7. **Comment ต้องตรงกับ behavior ปัจจุบันเสมอ** เมื่อแก้ logic ให้ตรวจ comment ของ function นั้น และ comment ใน test ที่อธิบาย flow เดียวกันด้วย
8. **Comment ต้องอยู่ติดกับสิ่งที่อธิบาย** ห้ามมี comment ของ function หนึ่งค้างอยู่เหนืออีก function หนึ่ง และห้ามมี `// Function` ซ้อนกัน 2 บรรทัด
9. **Comment ภาษาไทยต้องอ่านออก** ถ้าเจอตัวอักษรเพี้ยน (เช่น `เธ...` `เน...` ที่เกิดจาก UTF-8 ถูกอ่านเป็น cp874) ให้แก้กลับเป็นภาษาไทย และบันทึกไฟล์เป็น UTF-8 แบบ LF เสมอ

### Function

ใส่ทุก function ที่ประกาศระดับไฟล์ (ทั้ง export และไม่ export) รวมถึง arrow function ที่เก็บในตัวแปรระดับไฟล์ และ method ใน object mock/repository ที่ต้องอธิบาย:

```ts
// Function ตรวจสอบ refresh token และออก token ชุดใหม่
export async function refresh(body: unknown) {
  ...
}

// Function แบ่งข้อมูลเป็นชุดย่อยเพื่อลดขนาด transaction ตอน seed
const chunkArray = <T>(items: T[], size: number): T[][] => {
  ...
};
```

รูปแบบประโยค: `// Function <กริยา> <สิ่งที่ทำ> [เงื่อนไขสำคัญสั้นๆ]`

```ts
// ถูก
// Function ยกเลิก roster ที่ยัง WORKING ทั้งหมดของ Business Ticket
// Function หาแผงสำหรับส่งยอดจากประวัติการสแกนของ worker (รวม RELEASED)
// Function อัปโหลดรูป worker จาก hex ขึ้น Spaces คืน URL หรือ null ถ้าไม่มีรูป

// ผิด: หลายบรรทัด + อ้างประวัติการแก้ + ชื่อ fix
// Function ยกเลิก TicketWorker (roster) ที่ยัง WORKING ทั้งหมดของ Business Ticket ใบเดียว — ย้ายมาจาก
// adminJobsRepositoryMock ตาม Fix B เพราะ ...
```

### Config

ใช้กับ constant/config ที่ควบคุม behavior:

```ts
// Config status เริ่มต้นของ account
const DEFAULT_ACCOUNT_STATUS = "active";
```

### Format

ใช้กับ Zod format หรือ schema ชิ้นเล็กที่เป็น reusable format:

```ts
// Format เวลาแบบ HH:mm เท่านั้น ไม่รับวินาทีหรือ millisecond
const timeString = trimmedString.pipe(...);
```

### Schema

ใช้กับ Zod schema ที่ validate request หรือ payload:

```ts
// Schema body สำหรับ reset password ของ worker
export const resetPasswordBodySchema = z.object({
  ...
});
```

### Type

ใช้กับ type/interface โดยระบุว่าเป็นส่วนไหน (`DTO`, `Response`, `Repository input`, `Payload`, `Filters` ฯลฯ):

```ts
// Type ส่วน DTO ของ table accounts
export interface AccountDto {
  ...
}

// Type ส่วน Response ของ API user detail
export interface UserDetailResponse {
  ...
}

// Type ส่วน Repository input สำหรับสร้าง account
export interface AccountCreateInput {
  ...
}
```

### Mock (ใน test)

Mock object ระดับไฟล์ให้บอกว่าเป็น mock ของไฟล์ไหน บรรทัดเดียว:

```ts
// Mock ของ src/repositories/driver.repository.ts
export const driverRepositoryMock = {
  ...
};
```

### Comment ภายใน function และใน test

ใช้ได้เมื่อช่วยให้เข้าใจสิ่งที่อ่านจากโค้ดไม่ออก เขียนบรรทัดเดียว ไม่ต้องมี prefix:

```ts
// เก็บ telephone เป็นตัวเลขล้วน ให้ตรงกับค่าที่ใช้เป็น password
const normalizedTelephone = normalizePhoneDigits(worker.telephone);
```

ใน test ใช้บอก "สถานการณ์ที่จำลอง" หรือ "สิ่งที่คาดหวัง" สั้นๆ:

```ts
// จำลองกะที่ปิดเพราะไม่รับงานครบ แล้ว Admin force กลับ READY (reason_code ต้องไม่ค้างใน list)
// fund = 0.6 (ค่าแรงเหลือ) + 0.4 (ส่วนต่างปัดเศษ) ให้ 6 + 3 + 1 = 10 เท่ายอดที่เก็บ
```

สูตรคำนวณเงินที่อ่านเป็นขั้นตอนได้ชัด ใช้หลายบรรทัดสั้นๆ ได้:

```ts
// Product 1: labor 9 / 2
// Worker ได้ 4 + 4 = 8
// Fund = 1
```

ถ้าต้องบอกว่า "ทำไมไม่มี test กรณีนี้" ให้เขียนบรรทัดเดียวบอกเหตุผลหลัก:

```ts
// ไม่มี test 409 ASSIGNMENT_NOT_ACTIVE เพราะ query กรองเฉพาะ assignment ที่ active อยู่แล้ว
```

### เมื่อเจอ comment ยาวของเดิม

เมื่อแก้ไฟล์ที่มี comment หลายบรรทัดอยู่แล้ว ให้ย่อตามขั้นตอนนี้:

1. อ่านโค้ดใต้ comment ก่อน แล้วตรวจว่า comment ยังตรงกับ behavior ปัจจุบันหรือไม่ ถ้าไม่ตรงให้แก้ตาม behavior จริง
2. เก็บเฉพาะ "สิ่งที่ทำ" หรือ "rule ที่ต้องรู้" 1 ข้อ ตัดประวัติ เหตุผลยาว ชื่อ bug เลขบรรทัด และการอ้างไฟล์อื่นที่ไม่จำเป็นออก
3. ถ้า comment อธิบาย function ให้ขึ้นต้นด้วย `// Function`
4. ถ้าข้อมูลที่ตัดทิ้งสำคัญจริง (เช่น เหตุผลเชิงสถาปัตยกรรม) ให้ย้ายไปเขียนใน `docs/` แทน ไม่เก็บเป็น comment ยาวในโค้ด
5. แก้ comment อย่างเดียว ไม่เปลี่ยนโค้ดไปพร้อมกัน แล้วรัน `npm run build` และ `npm test` ยืนยันว่า behavior ไม่เปลี่ยน

## Naming Pattern

### File

- Route file ให้ตั้งชื่อตาม Swagger tag/feature เช่น `admin-workers.routes.ts`, `admin-jobs.routes.ts`, `worker.routes.ts`
- Service file ให้ตั้งชื่อตาม Swagger tag/feature เช่น `admin-workers.service.ts`, `admin-jobs.service.ts`, `worker.service.ts`
- Type file ให้ตั้งชื่อตาม Swagger tag/feature เช่น `admin-workers.type.ts`, `gate.type.ts`, `notifications.type.ts`
- OpenAPI file ให้แยกตาม Swagger tag/feature เช่น `admin-workers.yaml`, `admin-jobs.yaml`, `worker.yaml`
- `components.yaml` ใช้เก็บ OpenAPI schemas/security ที่หลาย route อ้างอิงร่วมกัน

### Function

- `find...` ใช้กับ query ที่อาจไม่เจอ และ return `null`
- `list...` ใช้กับรายการหลาย record
- `count...` ใช้นับจำนวน
- `create...` ใช้สร้าง record
- `update...` ใช้แก้ไข record
- `revoke...` ใช้ยกเลิก session/token
- `build...` ใช้สร้าง object/response/data/where condition
- `format...` ใช้จัดรูป response หรือ DTO เสริม
- `assert...` ใช้ตรวจ rule และ throw error ถ้าไม่ผ่าน
- `require...` ใช้ดึงข้อมูลที่ต้องมี ถ้าไม่มีให้ throw error
- `parse...` ใช้แปลงและ validate input

### Type

- `...Dto` สำหรับข้อมูลที่แปลงจาก database record
- `...Input` สำหรับ input ที่ส่งเข้า repository หรือ helper
- `...Response` สำหรับ response ที่ API/service ส่งกลับ
- `...Payload` สำหรับ JWT payload
- `...Config` สำหรับ config object
- `...Filters` สำหรับ filter/pagination ที่ repository ใช้

## Error Pattern

ใช้ `ApiError` ทุกครั้งที่เป็น error ที่ต้องส่งกลับ API

```ts
throw new ApiError(404, "USER_NOT_FOUND", "User not found.");
```

รูปแบบ error code:

- ใช้ UPPER_SNAKE_CASE
- message ภาษาอังกฤษ สั้นและชัด
- validation error ใช้ `VALIDATION_ERROR`
- auth token error ใช้ code เฉพาะ เช่น `INVALID_TOKEN`, `INVALID_REFRESH_TOKEN`

## Transaction Pattern

ใช้ `withTransaction` เมื่อ workflow เขียนหลาย table หรือหลาย operation ที่ต้องสำเร็จ/ล้มเหลวพร้อมกัน

ตัวอย่าง:

```ts
return withTransaction(async (transaction) => {
  const account = await accountRepository.create(input, transaction);
  await profileRepository.create(profileInput, transaction);

  return formatUserDetail(account, transaction);
});
```

Repository ทุกตัวที่เกี่ยวกับ database ควรรับ `connection?: DbConnection` เพื่อรองรับ transaction

## Response Pattern

Response ของ service ควรสร้างให้ชัดใน service ไม่กระจายใน route

- list response ใช้ `{ data, pagination }`
- detail response ใช้ object ตาม type เช่น `UserDetailResponse`
- action response ใช้ `{ message: "..." }`
- auth response ใช้ token + account/profile/schedule ตาม `AuthSuccessResponse`

## สิ่งที่ควรหลีกเลี่ยง

- อย่าใส่ business logic ใน route
- อย่า query Prisma จาก service โดยตรงถ้ามี repository อยู่แล้ว
- อย่าสร้าง type เผื่อไว้ถ้ายังไม่มีการ import ใช้งาน
- อย่าแยก helper/constant เพียงเพราะโค้ดซ้ำ ถ้า inline แล้วอ่านง่ายกว่า
- อย่าแยก helper ไป utils ถ้าใช้แค่ไฟล์เดียวและทำให้ตาม code ยากขึ้น
- อย่า duplicate config หลายที่ ถ้าค่าเดียวกันถูกใช้หลายไฟล์
- อย่าใช้ `any` ถ้าใช้ `unknown`, DTO, หรือ Prisma type ได้
- อย่า return password hash ใน response

## แนวทางปัจจุบันของ Project

### Service ตาม route/tag

- Service file ให้ตั้งชื่อตาม Swagger tag/route เป็นหลัก เช่น `admin-workers.service.ts`, `admin-jobs.service.ts`, `worker.service.ts`
- Logic ที่เป็นของ route ใด route หนึ่งให้เก็บไว้ใน service ของ route นั้น เพื่อให้ไล่จาก Swagger -> route -> service ได้ตรงกัน
- ถ้า logic เป็น background worker, Redis queue, BullMQ processor, หรือ dispatch queue ที่ไม่ได้ผูกกับ route เดียว ให้อยู่ใน `src/queues`

### Admin Settings Service

- `admin-settings.service.ts` เป็น Admin Settings application service สำหรับ Admin Settings API, Gate Clients, roles, validation และ response shape
- เหตุผลคือ runtime settings และ permissions ถูกใช้หลาย flow เช่น auth, worker, driver, admin jobs และ queue dispatch
- Function กลางที่ service อื่นเรียกใช้ได้ต้องอยู่ใน shared service เช่น `services/shared/runtime-settings.service.ts` และ `services/shared/account-permission.service.ts`
- `mergeRuntimeSettings` และ cache runtime settings ให้อยู่ใน `services/shared/runtime-settings.service.ts`
- ไม่ให้ Worker/Queue/Driver/Auth depend กับ `admin-settings.service.ts` เพื่อใช้ runtime settings หรือ permission resolution

### Repository Shared

- Shared repository logic ให้เก็บใน `src/repositories/shared` เฉพาะกรณีที่หลาย route ใช้ร่วมกันจริง
- ตัวอย่าง shared repository ที่ยอมรับได้ เช่น account, session, profile, permission, work-schedule, mapper, repository-utils
- Repository ที่เป็น feature-specific ให้ตั้งชื่อตาม Swagger tag เช่น `admin-workers.repository.ts`, `admin-jobs.repository.ts`, `gate.repository.ts`
- ถ้า repository เริ่มใหญ่ ให้แยกตาม table/กลุ่ม query ที่ใช้ร่วมกันจริงก่อน ไม่ย้ายทุกอย่างกลับไป feature เดียวจนเกิด duplicate query

### Types และ OpenAPI

- Type ที่ใช้จริงให้รวมไว้ใน `src/types` และแยกไฟล์ตาม route/tag เช่น `admin-workers.type.ts`, `admin-jobs.type.ts`, `worker.type.ts`
- Type จาก Zod สามารถย้ายมารวมใน `src/types` ได้ถ้ามีการ import ใช้งานจริง หรือช่วยให้ shape ของระบบอ่านชัดขึ้น
- OpenAPI ให้แยกไฟล์ตาม route/tag เช่น `admin-workers.yaml`, `admin-jobs.yaml`, `worker.yaml`
- `components.yaml` ใช้เก็บ schema/security ที่หลาย route อ้างอิงร่วมกัน ไม่ใช่ route หลักของระบบ

## Checklist ก่อนจบงาน

1. ชื่อไฟล์ตรงกับ feature หรือ layer หรือไม่
2. Logic อยู่ถูก layer หรือไม่
3. Comment ใช้รูปแบบ `Function`, `Config`, `Schema`, `Type ส่วน...` บรรทัดเดียว และยังตรงกับ behavior ปัจจุบันหรือไม่ (ดู Comment Pattern)
4. Type ที่เพิ่มมีการใช้งานจริงหรือไม่
5. Import ที่เพิ่มจำเป็นจริงหรือไม่ และอยู่ในกลุ่ม `// Import ...` ที่ถูกต้องแบบบรรทัดเดียวหรือไม่ (ดู Import Pattern)
6. ถ้าแก้ TypeScript logic ให้รัน `npm run build`
7. ถ้าแก้ behavior ให้รัน `npm test`

## Production Operations Pattern

- Production builds use immutable Docker images tagged by commit SHA.
- Application secrets must be provided at runtime by server env or a secret manager; never bake secrets into Docker images, compose files, workflows, or source.
- Production Prisma migrations use `npm run db:deploy` / `prisma migrate deploy` only.
- Production health check uses `/ready` as the single operational endpoint; it checks required dependencies before traffic is accepted.
- Deployment runbooks and server-specific setup belong in `docs/deployment.md` and `docs/production-runbook.md`, not in this architecture pattern file.
