# Test Structure

ระบบ test แยกตามระดับการทดสอบและ source route จริงของโปรเจกต์ เพื่อให้รู้ทันทีว่า test แต่ละชุดตรวจส่วนไหนของระบบ

## Folders

- `setup/` - ตั้งค่า test environment และ guard กันการยิงฐานข้อมูล production/staging
- `helpers/` - test harness, mock repository, helper สำหรับเรียก Express app/routes
- `unit/` - ทดสอบ function/config/schema ที่ไม่ต้องต่อ DB หรือ external service
- `routes/` - ทดสอบ HTTP endpoint ตาม route จริง โดยเรียกผ่าน Express app และ service/repository ของโปรเจกต์
- `integration/` - ทดสอบร่วมกับ DB/Redis หรือ dependency จริง เฉพาะเมื่อเปิด env สำหรับ test
- `realtime/` - สำหรับ WebSocket/SSE/presence tests
- `e2e/` - สำหรับ flow ข้ามหลาย route/service แบบ end-to-end
- `concurrency/` - สำหรับ race condition, FIFO, simultaneous queue, dispatch ordering

## Commands

- `npm test` - รัน P0 unit + route tests ที่ไม่แตะ DB จริง
- `npm run test:unit` - รัน unit tests
- `npm run test:routes` - รัน route endpoint tests
- `npm run test:integration` - รัน integration tests พร้อม safe guard
- `npm run test:p0` - alias สำหรับ P0 tests
- `npm run test:all` - รันทุกชุดที่เปิดไว้

## Database Safety

integration tests ที่ต้องต่อ DB ต้องเปิด `RUN_DB_TESTS=1` และ `DATABASE_URL` ต้องเป็นฐานข้อมูล test เท่านั้น โดย helper จะ reject URL ที่มีคำว่า `prod`, `production`, หรือ `staging`
