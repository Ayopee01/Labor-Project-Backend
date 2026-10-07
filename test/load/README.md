# Production Flow + Load Test

สคริปต์ยิง **server จริงที่ deploy แล้ว** เพื่อตรวจว่าทำงานตรง spec + flow การทำงานภายใต้โหลด worker หลายคน — ใช้ตรวจหลัง deploy บน server ใหม่/อื่นได้

ต่างจาก `test/integration` และ `test/e2e` ที่รันบน DB แยก (ตรวจ logic/เงินแบบ isolated) — ตัวนี้ยิง **API + WebSocket จริง** ผ่าน network เพื่อดู performance + flow บนเครื่องจริง จึง **ไม่รวมใน `test:all`** และต้องสั่งรันเอง

## สิ่งที่ตรวจ (1 รอบ)

0. **Self-clean** — force worker ค้าง → `open_app` + **ยกเลิกงานค้าง** (WAIT/WORKING) ทั้งหมด ให้ pool + คิวสะอาดก่อนเริ่ม
1. **Login load** — login worker หลายคนพร้อมกัน วัด login/s + latency (ดู stampede ตอนเข้ากะ)
2. **Online** → เข้าคิว ready
3. **Multi-worker happy path** — ยิงงาน qty 100 (WorkerCount ≥ 2) ให้ทีม accept → scan → ส่งยอด → vendor confirm → financialize → **เงินหารจริง** (invariant `payout + fund ≥ laborFeeRaw`, ไม่สูญจากปัดเศษ)
4. **Dispatch false→true** — สร้างงาน `Dispatch:false` แล้ว admin เปิด dispatch → เรียก worker สำเร็จ
5. **Admin ยกเลิก assignment** — worker รับงานแต่ยังไม่ scan → admin cancel → ถอดคนกลับคิว
6. **Admin release-workers** ตอน vendor ยังไม่ยืนยัน → ทีมกลับคิว
7. **Break → กลับมาทำงาน**
8. **Vendor timeout → auto-close** — ลด `VendorConfirmTimeoutMinutes` เป็น 1 นาทีชั่วคราว, ส่งยอดแล้วไม่กดยืนยัน, รอ ~90s ให้ระบบปิดยอดเอง, แล้ว**คืนค่าเดิม**
9. **Invalid flow ต้อง throw** — accept งานไม่มี → 4xx, TicketNo == TicketNumber → 400
10. **กฎ gate** — แก้ตั๋วจนไม่มีแผง → 409 `GATE_TICKET_MINIMUM_BOOTH_REQUIRED`
11. **Logout worker ทุกคน** + **ยกเลิกงานค้างทั้งหมด** (ผ่าน `assignment/cancel` ส่งแค่ `TicketNumber` = ยกเลิกทั้งคัน) → หลังรันเหลือเฉพาะงาน COMPLETED/CANCELLED ไม่มี "รอลง"/"กำลังทำงาน" ค้าง
12. สรุป PASS/FAIL ทุกข้อ + exit code (0 = ผ่านหมด)

> ความถูกต้องของสูตรเงินเป๊ะ (rate × จำนวน ÷ คน, ปัดเศษ, ยกเลิกคนแล้วหารใหม่, vendor reject) + accept/scan timeout + socket grace + gate แก้หลังส่งยอด → ตรวจเชิงลึกที่ `test/integration/database/*` และ `test/e2e` (รันบน DB แยก)

## วิธีรัน

```bash
# ชี้ server + DB (read-only ใช้ดึง active worker + booth อัตโนมัติ) + gate secret
TARGET_URL=https://<server-host> \
DATABASE_URL="postgresql://.../<db>?sslmode=require" \
GATE_CLIENT_SECRET="<gate secret>" \
npm run test:load
```

### ตั้งค่าได้ (env)

| env | default | ความหมาย |
|---|---|---|
| `TARGET_URL` | prod host | base URL ของ server ที่จะทดสอบ |
| `GATE_CLIENT_ID` / `GATE_CLIENT_SECRET` | `gate-main` / — | credential ของ gate client (secret บังคับ) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / `Admin@123456` | admin สำหรับอ่าน financials |
| `MARKET_CODE` | `1111` | ตลาดที่มี rate |
| `SOLO_PRODUCT` / `SOLO_PACKAGE` / `SOLO_QTY` | `01010401` / `07` / `5` | สินค้า WorkerCount=1 (scenario ย่อย) |
| `TEAM_PRODUCT` / `TEAM_PACKAGE` / `TEAM_QTY` / `TEAM_TICKETS` | `02020300` / `28` / `100` / `3` | สินค้า qty สูง → WorkerCount ≥ 2 (ทีม + หารเงิน) |
| `WORKER_COUNT` / `WORKER_OFFSET` | `14` / `0` | จำนวน worker + index เริ่ม |
| `DATABASE_URL` | — | ถ้าให้ จะดึง active worker (status=1) + booth ของ market อัตโนมัติ (read-only) |
| `WORKER_CREDS_FILE` | — | ทางเลือกแทน DB: ไฟล์ JSON `[{"username","password"}]` (password = เบอร์โทร digits) |
| `BOOTH_CODES` | — | ทางเลือกแทน DB: booth คั่น comma เช่น `SV1/1,SV1/2` |

## ข้อควรรู้

- **ควรรันบน server ที่ "สะอาด"** (เพิ่ง deploy / ยังไม่มี orphan vehicle job ค้าง) — ถ้ามี ticket WORKING ค้างที่ไม่มีคน dispatch FIFO จะจ่ายงานเก่าให้ worker ก่อน ทำให้ flow ของรอบนี้ไม่ครบ
- **สร้างข้อมูลจริง** (vehicle job + financial) ลง DB ของ server นั้น — ใช้กับ server ทดสอบ/staging/pre-launch เท่านั้น ไม่ใช่ตอนมีผู้ใช้จริง
- **worker online จาก open_app ได้ครั้งเดียวต่อกะ** — รันซ้ำในกะเดียวกัน **ต้องเลื่อน `WORKER_OFFSET`** ไปใช้ worker ชุดใหม่ทุกครั้ง (เช่น รอบ 1 offset 0, รอบ 2 offset 20, ...) ไม่งั้นจะ online 0 ราย
- scenario vendor-timeout **แก้ `VendorConfirmTimeoutMinutes` ชั่วคราวเป็น 1** แล้วคืนค่าเดิมเมื่อจบ — ระหว่างนั้น (~90s) ค่านี้มีผลกับทั้ง server จึงควรรันตอนไม่มีผู้ใช้จริง
- ต้องอยู่ในช่วงกะของ worker (เช่น Morning 05:00–21:00) ไม่งั้น online ได้ `403 OUTSIDE_WORK_SHIFT`
