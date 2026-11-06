# Test Structure

ระบบ test แยกตามระดับการทดสอบและ source route จริงของโปรเจกต์ เพื่อให้รู้ทันทีว่า test แต่ละชุดตรวจส่วนไหนของระบบ

## Folders

- `setup/` - ตั้งค่า test environment และ guard กันการยิงฐานข้อมูล production/staging
- `helpers/` - test harness, mock repository, helper สำหรับเรียก Hono app/routes
- `unit/` - ทดสอบ function/config/schema ที่ไม่ต้องต่อ DB หรือ external service
- `routes/` - ทดสอบ HTTP endpoint ตาม route จริง โดยเรียกผ่าน Hono app และ service/repository ของโปรเจกต์
- `integration/` - ทดสอบร่วมกับ DB/Redis หรือ dependency จริง เฉพาะเมื่อเปิด env สำหรับ test
- `realtime/` - สำหรับ WebSocket/SSE/presence tests
- `e2e/` - สำหรับ flow ข้ามหลาย route/service แบบ end-to-end
- `concurrency/` - สำหรับ race condition, FIFO, simultaneous queue, dispatch ordering

## Runtime

- Unit และ Route tests รันบน Node ผ่าน `tsx` เพราะ mock module ด้วย `Module._load` ซึ่งไม่ทำงานบน `bun test`
- Integration, Concurrency, E2E และ Realtime tests รันบน Bun เหมือน production (test ใช้ `node:test` จึงรันด้วย `node --import tsx --test <file>` ได้เช่นกัน)

## Commands

- `bun run test` - รัน P0 unit + route tests ที่ไม่แตะ DB จริง
- `bun run test:unit` - รัน unit tests
- `bun run test:routes` - รัน route endpoint tests
- `bun run test:integration` - รัน integration tests พร้อม safe guard
- `bun run test:concurrency` - รัน race condition, FIFO และ idempotency tests
- `bun run test:e2e` - รัน flow งานของ Worker ตั้งแต่ต้นจนจบ
- `bun run test:realtime` - รัน WebSocket tests
- `bun run test:p0` - alias สำหรับ P0 tests
- `bun run test:all` - รันทุกชุดที่เปิดไว้
- `bun run test:load` - flow และ load test บน server จริง (ไม่อยู่ใน `test:all`)
- `bun run db:reset-test` - ล้างข้อมูลที่ load test สร้างไว้

## Database Safety

tests ที่ต่อ DB/Redis จริง (integration, concurrency, e2e, realtime) ต้องเปิด `RUN_DB_TESTS=1` และ helper จะตรวจก่อนรัน:

- `DATABASE_URL` ต้องมีคำว่า `test` ในชื่อ (เช่น `labor_project_test`) และต้องไม่มีคำว่า `prod`, `production` หรือ `staging`
- `REDIS_URL` ต้องใช้ logical DB index ที่ไม่ใช่ 0 (เช่น `redis://localhost:6380/15`)

รันบนเครื่องด้วย docker (`docker compose --profile local-db up -d postgres redis`):

```bash
docker exec labor-postgres createdb -U postgres labor_project_test
export DATABASE_URL=postgresql://postgres:password@localhost:5434/labor_project_test
export REDIS_URL=redis://localhost:6380/15
export DATABASE_CA_CERT=   # ปิด SSL ของ DB local (ค่าใน .env ใช้กับ DB บน DigitalOcean)
bun run db:deploy && bun run db:seed:test-settings
RUN_DB_TESTS=1 bun run test:all
```
