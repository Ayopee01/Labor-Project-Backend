# Flow การทำงานระบบ Labor

เอกสารนี้อธิบาย flow การทำงานของระบบตั้งแต่ Worker เริ่มกะ รถเข้า Gate จนปิดยอดเงิน รายละเอียด request/response ของแต่ละ API ดูที่ Swagger (`/api-docs`, source: `src/docs/openapi`)

## ภาพรวม

ผู้ใช้งานในระบบ:

| ผู้ใช้ | ช่องทาง | หน้าที่ |
| --- | --- | --- |
| Gate | REST (Basic Auth ด้วย Gate client) | สร้างงานรถและ Business Ticket |
| Driver | Driver Web (QR session + SSE) | แจ้งรถพร้อมลงสินค้า และติดตามสถานะงาน |
| Worker | Mobile App (REST + WebSocket + FCM) | เข้าคิว รับงาน สแกนเข้างาน ส่งยอด |
| Vendor (เจ้าของแผง) | LINE OA | ยืนยัน/ตีกลับยอด และให้คะแนน |
| Admin | Admin Web (REST + SSE) | ควบคุมงาน จัดการทีม ดูรายงาน ตั้งค่าระบบ |

ลำดับข้อมูลหลัก: งานรถ (`ticket_jobs`, อ้างอิงด้วย `TicketNumber`) → Business Ticket (`market_jobs`, 1 ใบต่อ 1 ตลาด, อ้างอิงด้วย `TicketNo`) → แผง (`booth_jobs`, อ้างอิงด้วย `BoothCode`) → สินค้า (`ticket_products`)

## สถานะหลัก

| ข้อมูล | สถานะ |
| --- | --- |
| งานรถ / Business Ticket | `WAIT` → `WORKING` → `COMPLETED` / `CANCELLED` (งานรถมี `RELEASED` เมื่อ Admin ปล่อยทีมก่อน Vendor ยืนยันครบ) |
| แผง (Booth) | `WAIT` → `WORKING` → `DELIVERED` (ส่งยอดรอ Vendor) → `COMPLETED` / `REJECT` (ตีกลับ ส่งใหม่ได้) / `CANCELLED` |
| Assignment ของ Worker | `PENDING` → `ACCEPTED` → `SCANNED` → `WORKING` → `DELIVERED` / `REJECT` → `COMPLETED` (หรือ `TIMEOUT` / `CANCELLED`) — ถ้า Admin release ก่อน: `DELIVERED` → `RELEASED` → `COMPLETED` ตอนงานรถปิด (คง `released_at` ไว้) |
| Roster ของ Business Ticket (`ticket_workers`) | `WORKING` → `COMPLETED` (ตอนปิดยอด) / `CANCELLED` (ถูกถอด) |
| สถานะคิวของ Worker (Redis) | `open_app` → `ready` → `assigned` → `waiting_team` → `working` (และ `break`) |

---

## Step 0: Worker เริ่มกะและเข้าคิว

1. **ตรวจ version แอป**: `GET /api/workers/app-version/check` (ไม่ต้อง login) เทียบ BuildNumber กับ version ที่มีผลตามเวลา server เพื่อบังคับหรือแนะนำให้อัปเดต
2. **Login**: `POST /api/auth/login` ส่ง DeviceId/DeviceName และ FCM token (ถ้ามี) ถ้ามี session บนเครื่องอื่นจะได้ `ACTIVE_SESSION_EXISTS` ให้ยืนยันด้วย `POST /api/auth/login/confirm-force` (ปิด session เดิมและแจ้งเครื่องเดิมแบบ best-effort) FCM token ที่ได้ภายหลังส่งที่ `POST /api/auth/push-token`
3. **เชื่อมต่อ WebSocket** `GET /ws/workers` (ดูหัวข้อ Realtime) — ต้องเชื่อมต่ออยู่จึงจะเข้าคิวได้
4. **เข้าคิว**: `POST /api/workers/me/online` ต้องอยู่ในเวลากะ (`shift_name` / `time_in` / `time_out` ของ Master Worker) ระบบบันทึก attendance, ใส่ Worker ท้ายคิว FIFO ใน Redis (สถานะ `ready`) และตั้ง BullMQ job `worker-shift-end` สำหรับตอนหมดกะ
5. **ระหว่างกะ**:
   - **กลับจากพักทุกกรณีไปต่อท้ายคิวเสมอ** เหมือนเข้าคิวใหม่ ไม่ว่าจะกลับเองก่อนเวลา ครบเวลาแล้ว job พากลับ หรือขอพักไม่สำเร็จเพราะเกินโควตา
   - `POST /api/workers/me/break` พักได้เฉพาะตอนยังไม่ถูก assign งาน ตามจำนวนครั้ง (`worker_break_limit`) และเวลา (`worker_break_duration_minutes`) ที่ตั้งไว้ ครบเวลาแล้ว job `worker-break-return` พากลับเข้าคิว ถ้าตอนนั้น socket หลุด ระบบรอให้ต่อกลับภายใน `worker_break_retry` นาที (แจ้ง `WORKER_BREAK_RETURN_ACTION_REQUIRED`) เกินเวลาจะค้างเป็น `open_app` เหตุผล `break_retry_expired` ให้ Admin จัดการ
     - ระหว่างรอ (`open_app` เหตุผล `break_ended_awaiting_reconnect`) จะพากลับเข้าคิวอัตโนมัติตอนต่อ socket ได้ก็ต่อเมื่อเหตุผลยังเป็นค่านี้ อยู่ในกะเดิม กะยังไม่ถูกปิด และไม่มีงานค้าง ถ้า Admin force เป็น `open_app` (เหตุผลเปลี่ยนเป็น `admin_forced_status`) หรือกะถูกปิดไปก่อน จะไม่พากลับเข้าคิวและไม่แจ้ง `WORKER_BREAK_RETRY_EXPIRED` ต้องให้ Admin force กลับเข้าคิวเอง
     - ถ้า Admin revoke session ระหว่างรอ ระบบจะไม่ปิดกะให้ (เหตุผลยังเป็น `break_ended_awaiting_reconnect`) Worker ที่ login แล้วต่อ socket กลับมาทันเวลาจะกลับเข้าคิวได้ตามปกติ
   - `POST /api/workers/me/offline` ออกจากคิว และกลับเข้าคิวไม่ได้อีกจนกะถัดไป
   - `GET /api/workers/me/status` ใช้ restore หน้าจอหลังเปิดแอปใหม่ (profile, กะ, สถานะคิว, งานปัจจุบัน, เหตุผลที่ปิดกะ)
6. **หมดกะ**: job `worker-shift-end` ปิด attendance และย้าย Worker ที่ว่างเป็น `open_app` ถ้ายังมีงานค้างจะให้ทำงานต่อจนจบ แล้วค่อยออกตอนส่งยอด/ปิดงาน
7. **สาเหตุที่ Worker ถูกย้ายเป็น `open_app`** (`open_app_reason`): `scan_timeout`, `admin_cancel_assignment`, `admin_forced_status`, `break_ended_awaiting_reconnect`, `break_retry_expired` รวมถึงหมดกะ และกดรับงานไม่ทันครบ `worker_accept_timeout_limit` ครั้ง (ปิดกะ)

---

## Step 1: Driver เข้ามา Gate

Gate ออกตั๋วให้รถ 1 คันได้หลายตลาดในครั้งเดียว (ตั๋ว 1 ใบต่อ 1 ตลาด แต่ละใบมี `TicketNo` ของตัวเอง ซึ่งเป็นเลขที่พิมพ์เป็นบาร์โค้ดให้ Worker สแกน)

`POST {{baseUrl}}/api/gate/tickets`

Body

```json
{
  "TicketNumber": "เลข Ticket ใหญ่ ระดับรถ",
  "GateNo": "ช่อง Gate ที่ออกตั๋ว (ข้อความอิสระที่ระบบ Gate กำหนด)",
  "LicensePlate": "เลขทะเบียน Gate จะส่งมา",
  "LicensePlateProvince": "จังหวัดทะเบียน Gate จะส่งมา",
  "VehicleTypeCode": "Code ประเภทรถ",
  "VehicleTypeName": "Name ประเภทรถ",
  "Markets": [
    {
      "TicketNo": "เลข Ticket ระดับตลาด (ห้ามซ้ำใน request)",
      "TicketCreatedAt": "เวลาที่ Gate สร้างตั๋วใบนี้",
      "MarketCode": "Code ของ Market อิงจาก DB",
      "DropoffPoint": "จุดลงสินค้าของตั๋วใบนี้",
      "Booths": [
        {
          "BoothCode": "Code ของแผง (ห้ามซ้ำในตั๋วเดียวกัน)",
          "Products": [
            {
              "ProductCode": "Code ของสินค้า",
              "PackageCode": "Code ของแพ็คเกจสินค้า",
              "Quantity": "จำนวน"
            }
          ]
        }
      ]
    }
  ],
  "Dispatch": true,
  "IdempotencyKey": "(ไม่บังคับ) key สำหรับ retry ถ้าไม่ส่งระบบจะ hash ทั้ง body แทน"
}
```

- `GateNo`: บันทึกคู่กับ Gate client ที่ยิง request (จาก Basic Auth) ไว้ที่ตั๋ว (`market_jobs.gate_no` / `gate_client_id`) และ `gate_request_logs` แล้วส่งกลับใน response เพื่อพิมพ์ตั๋ว
- `Dispatch`: `true` งานรถเป็น `WORKING` และเรียก Worker ทันที, `false` งานรถเป็น `WAIT` รอ Driver เป็นคนเปลี่ยน status เอง
- ทุกตลาดใน request สร้างใน transaction เดียว ถ้าตลาดใดไม่ผ่าน (เช่น master data ไม่ครบ) จะไม่บันทึกทั้ง request
- รถหนึ่งคัน (`TicketNumber`) ส่ง request ใหม่เพื่อเพิ่มตั๋วได้ แต่ `TicketNo` ที่ยัง active อยู่แล้วจะถูกปฏิเสธ (`GATE_TICKET_ALREADY_EXISTS`) ให้แก้ไขผ่าน PUT แทน
- `TicketNo` ต้องไม่ซ้ำกับตั๋วที่ยังไม่ถูกยกเลิกของรถคันอื่น ไม่อย่างนั้นตอบ 409 `TICKET_NO_ALREADY_EXISTS` พร้อม `ExistingTicketNumber` / `ExistingMarketCode` (DB บังคับด้วย unique index เดียวกัน) เพราะ GET/PUT หาตั๋วจาก `TicketNo` อย่างเดียว ตั๋วที่ยกเลิกแล้วไม่นับ จึงออกเลขเดิมใหม่ได้
- Realtime ตอนสร้าง: รถใหม่ Admin ได้ SSE `VEHICLE_JOB_CREATED` ส่วนการเพิ่มตั๋วให้รถเดิม Admin และ Worker ที่อยู่บนรถ (ก่อน dispatch รอบนี้) ได้ `TICKET_JOB_UPDATED` (`ChangeType = TICKET_ADDED`) ตั๋วละ 1 event รูปแบบเดียวกับตอน Gate แก้ไข ไม่ส่ง `VEHICLE_JOB_CREATED` และ request ที่ replay ไม่ส่ง event ซ้ำ
- ระบบ snapshot Rate และจำนวน Worker ต่อสินค้าจาก Master ไว้ตั้งแต่ตอนนี้ (Rate ใช้คำนวณเงินตอน Financialize, จำนวน Worker ใช้คิดใหม่ตอนแก้ไขตั๋ว)

Response

```
{
  "Result": "CREATED | REPLAYED",           // ส่ง request เดิมซ้ำ (idempotent) จะได้ REPLAYED
  "TicketNumber": "...",
  "GateNo": "ส่งกลับตามที่ส่งมา",
  "Vehicle": {
    "LicensePlate": "...",
    "LicensePlateProvince": "...",
    "VehicleTypeCode": "...",
    "VehicleTypeName": "...",
    "Status": "unload_now | waiting_unload"
  },
  "Markets": [                               // ตั๋วที่สร้างใน request นี้ ใช้พิมพ์ทีละใบ
    {
      "TicketNo": "...",
      "TicketCreatedAt": "...",
      "MarketCode": "...", "MarketName": "...", "DropoffPoint": "...",
      "BoothCount": 2,
      "WorkerCount": 3,                      // MAX ของทุกสินค้าทุกแผงในตั๋วใบนี้
      "Booths": [ /* GateTicketResponseBooth[] */ ]
    }
  ],
  "WorkerCount": 5,                          // SUM ของ WorkerCount ทุกตั๋วที่ active บนรถ (รวมตั๋วที่สร้างไว้ก่อน) ใช้ dispatch
  "Qr": { "DriverQrToken": "...", "DriverQrUrl": "..." }  // ใช้ร่วมกันทั้งคัน
}
```

ระบบยังไม่คำนวณยอดเงินตรงนี้ (ทำตอน Financialize หลังงานเสร็จ) — ดูรายละเอียด schema เต็มที่ `GateTicketResponse` ใน `src/docs/openapi/components.yaml`

หมายเหตุ: `Dispatch: true` จะเรียก `dispatchReadyWorkers()` ทันทีหลังสร้าง Ticket เสร็จ (ดู Step 2) ส่วน `Dispatch: false` งานรถจะอยู่สถานะ `WAIT` รอ Driver มากด "พร้อม" เองที่ `POST /api/driver/jobs/{ticketNumber}/ready`

### Step 1.1: Gate ดูและแก้ไขตั๋ว

ค้นหาและแก้ไขทีละใบด้วย `TicketNo` (เลขเดียวกับบาร์โค้ดที่ Worker สแกน) ไม่แก้ทั้งรถพร้อมกัน

- `GET /api/gate/tickets/{ticketNo}` คืนข้อมูลปัจจุบันของตั๋ว พร้อม `MarketEditable`, `Editable` / `LockReason` ของแผง (`TICKET_ALREADY_SUBMITTED`, `BOOTH_ALREADY_CLOSED`) แผงที่ถูกยกเลิกไม่แสดง Gate แก้ JSON นี้แล้วส่งกลับด้วย PUT ได้เลย
- `PUT /api/gate/tickets/{ticketNo}` ส่ง `GateNo`, `MarketCode`, `DropoffPoint` และ `Booths` เป็นสภาพสุดท้ายของตั๋วทั้งใบ ระบบเทียบกับของเดิมเอง

ระบบแก้ข้อมูลในแถวเดิมเสมอ (MarketJob/BoothJob/TicketProduct id คงเดิม) และใช้ `CANCELLED` เฉพาะแผงที่ถูกนำออกจริง

| กรณี | ระบบทำ | LINE Vendor |
| --- | --- | --- |
| แผงเดิม สินค้า/แพ็คเกจ/จำนวนเหมือนเดิม | คงไว้ ไม่แตะ (Rate snapshot เดิม) | - |
| แผงหายไปจาก request | ยกเลิกแผง (`CANCELLED`) | แจ้งยกเลิก |
| แผงเดิมแต่สินค้าเปลี่ยน | แก้ BoothJob แถวเดิม: สินค้าจับคู่ด้วย `ProductCode + PackageCode` — เดิม = อัปเดตจำนวน/จำนวนคน (Rate snapshot เดิม), ใหม่ = สร้าง, ที่หายไป = ลบ | แจ้งแก้ไขรายการสินค้า (รายการล่าสุด) |
| แผงใหม่ | สร้างแผง | แจ้งลงสินค้า |
| `MarketCode` เปลี่ยน | แก้ MarketJob แถวเดิม (`TicketNo` และช่อง Gate ที่ออกตั๋วคงเดิม) แผงที่ `BoothCode` ยังอยู่แก้ในแถวเดิมพร้อมชื่อแผง/Vendor/Rate snapshot ของตลาดใหม่ แผงที่ไม่ได้ส่งมาถูกยกเลิก | แผงที่ยกเลิกแจ้งยกเลิก, แผงที่คงไว้แจ้งยกเลิกถึง Vendor ตลาดเดิมแล้วแจ้งลงสินค้าถึง Vendor ตลาดใหม่ |
| `DropoffPoint` เปลี่ยน | แก้ MarketJob แถวเดิม | - |

- แก้ได้จนกว่าจะมีแผงใดในตั๋วใบนั้นส่งยอด (รวมแผงที่ถูกตีกลับแล้ว Admin ยกเลิก) จากนั้นทุก PUT ตอบ 409 `TICKET_ALREADY_SUBMITTED` และไม่บันทึกอะไรเลย ให้ Admin จัดการต่อ ตั๋วใบอื่นบนรถคันเดียวกันที่ยังไม่ส่งยอดแก้ได้ตามปกติ
- แผงที่ Admin ยกเลิกไปแล้ว Gate ส่งกลับมาไม่ได้: ตอบ 409 `BOOTH_CANCELLED_BY_ADMIN` พร้อม `Booths[]` (BoothCode, CancelledAt, CancelledByName, ReasonCode, ReasonText) และไม่บันทึกอะไรเลย ส่วนแผงที่ Gate นำออกเองเพิ่มกลับได้ตามปกติ
- Gate ลบแผง/สินค้าจนตั๋วว่างไม่ได้: `Booths` ว่างหรือมีแผงที่ `Products` ว่าง ตอบ 409 `GATE_TICKET_MINIMUM_BOOTH_REQUIRED` ก่อนแตะข้อมูล (การยกเลิกตั๋วทำได้เฉพาะ Admin)
- ลำดับ lock เหมือนตอนสร้าง (`ticket_jobs` → `market_jobs` → `booth_jobs`) และการส่งยอด lock แถว `booth_jobs` ก่อนตรวจสถานะ จึงไม่ชนกับ Worker ส่งยอด
- คิด `WorkerCount` ใหม่จาก snapshot (MAX ของตั๋ว, SUM ของรถ) ถ้าคนเกิน ระบบยกเลิก assignment ที่ยังไม่สแกนโดยเริ่มจากคนที่ได้งานล่าสุด แล้วคืนเข้าหน้าคิว (หมดกะไป `open_app`) พร้อมแจ้ง `ASSIGNMENT_CANCELLED` (มี `Queue` ล่าสุด) และ Admin ได้ SSE `WORKER_STATUS_CHANGED` ให้ Worker Board อัปเดต ส่วนคนที่สแกนแล้วทำงานต่อ ถ้าคนขาดและทีมยังสแกนไม่ครบรอบแรก ระบบเรียก Worker เพิ่มตามลำดับคิวงาน แต่ถ้าทีมเริ่มงานแล้ว ส่วนที่เพิ่มเป็นช่องว่าง (`unfilled_slot_count`) ให้ Admin เลือกคนจากคิวเอง ทีมเดิมส่งยอดได้และหารกันเอง ถ้าจำนวนลดลง ระบบใช้ช่องว่างก่อนแล้วค่อยตัดคนที่ยังไม่สแกน
- Worker ทุกคนที่ยังอยู่บนรถได้ `TICKET_JOB_UPDATED` (`ChangeType = TICKET_UPDATED`, socket + FCM + inbox) ครั้งเดียวพร้อมสรุปแผงที่เพิ่ม/แก้/นำออก (`AddedBoothCodes`/`UpdatedBoothCodes`/`RemovedBoothCodes` และ `MarketJobId`) Admin ได้ SSE event เดียวกัน และ Driver Web ได้ `DRIVER_JOB_UPDATED` (หรือ `DRIVER_JOB_TERMINAL` ถ้างานจบ) การแก้ไขไม่ส่ง `STALL_JOB_CANCELLED`/`MARKET_JOB_CANCELLED`
- ทุกคำขอบันทึกที่ `gate_request_logs` (`request_type = UPDATE`) พร้อม `gate_no`, `gate_client_id`, `change_summary`, `before_snapshot` และ `after_snapshot` (ตลาด/จุดลง/แผง/สินค้าก่อนและหลัง) แสดงใน Audit เป็น `gate_ticket_updated` (`actor_type = gate`, `Before`/`After`) ส่วนแผงที่ถูกนำออกบันทึกลง `admin_action_logs` ด้วย `ReasonCode = GATE_TICKET_UPDATED` โดย actor เป็น Gate client (`actor_gate_client_id`)
- ไม่มีอะไรเปลี่ยนจะได้ `Result: NO_CHANGE` และไม่มีการแจ้งเตือน
- การถอด Worker ออกจากแผง (Admin) ยังอยู่กับแผงเดิมเพราะ BoothJob id ไม่เปลี่ยน
- หน้า Admin operations แสดงตลาด/แผงที่ Admin ยกเลิก (สถานะ `CANCELLED`) ตามปกติ แต่ไม่แสดงแถวที่ Gate ยกเลิกตอนแก้ไขตั๋ว (แยกจาก `admin_action_logs` ที่ `reason_code = GATE_TICKET_UPDATED`) จึงเห็นเฉพาะข้อมูลใหม่ที่ Gate แก้ ใช้กฎเดียวกันกับรถที่ Admin ยกเลิกทั้งคัน (เห็นเฉพาะแถวที่ Admin ยกเลิก) ส่วนแถวที่ Gate ยกเลิกยังเก็บไว้ตรวจสอบใน history/audit
- ถ้า Gate ลบแผงแล้วส่ง BoothCode เดิมกลับมาภายหลัง จะได้ BoothJob แถวใหม่ แถวเดิมเป็น `CANCELLED` และถูกซ่อนจาก Worker/Driver Web (`excludeReplacedBooths`) เพื่อไม่ให้เห็นแผงเดียวกันซ้ำ
- ถ้ารถที่ release ทีมไปแล้วได้แผงใหม่ งานรถเปิด dispatch กลับเป็น `WORKING` เพื่อหาคนมาลงแผงใหม่

---

## Step 2: ระบบคำนวณจำนวน Worker และจ่ายงานจากคิว FIFO

เมื่องานรถพร้อม dispatch (Gate ส่ง `Dispatch: true` มาตั้งแต่แรก, หรือ Driver กด `/ready` ทีหลัง, หรือ Admin เปิด dispatch ผ่าน `POST /api/admin/vehicle-jobs/{ticketNumber}/wait` ด้วย `DispatchNow: true`) ระบบจะเรียก `dispatchReadyWorkers()` (`src/queues/worker-dispatch.ts`)

1. หางานรถที่ dispatch ได้ (`listDispatchableTicketJobs` — สถานะ `WORKING` เท่านั้น ไม่รวม `RELEASED`)
2. ต่อคันรถ (`dispatchReadyWorkersForTicketJob`): **lock แถว `ticket_jobs` ด้วย `SELECT ... FOR UPDATE`** ก่อนนับ active assignment กันสอง process จ่าย Worker ให้คันเดียวกันซ้ำพร้อมกัน
3. คำนวณ `workersNeeded = workers_required - activeAssignments`
4. ดึง Worker จาก Redis FIFO queue ด้วย `ZPOPMIN` (atomic — ดูหัวข้อ Concurrency) ตามจำนวนที่ขาด
5. ต่อ Worker แต่ละคนที่ pop มา: ตรวจตารางกะปัจจุบันอีกครั้ง (กันกรณี dispatch ช้าจนกะหมดพอดี) ถ้าอยู่ในกะจริงถึงสร้าง `TicketJobAssignment` (สถานะ `PENDING`) พร้อม `accept_deadline_at` (`worker_accept_deadline_seconds` จาก runtime settings) แล้วตั้ง BullMQ delayed job สำหรับ accept-timeout
6. ส่ง WebSocket event `WORKER_ASSIGNED` ให้ Worker คนนั้น (พร้อม FCM push) และ SSE `WORKER_ASSIGNED` ให้ Admin
7. Worker ที่ pop มาแล้วสร้าง assignment ไม่สำเร็จ ถูกใส่กลับหน้าคิว (ถ้ายังอยู่ในกะ) ไม่เสียลำดับ

Admin ควบคุม dispatch เองได้:

- `POST /api/admin/vehicle-jobs/{ticketNumber}/wait` เปิด (`DispatchNow: true`) หรือปิด (`DispatchNow: false`) การเรียก Worker ได้เฉพาะก่อนทีมสแกนครบ การปิดจะคืน Worker ที่ถูก assign ไว้กลับหน้าคิว และงานรถกลับเป็น `WAIT`
- `POST /api/admin/vehicle-jobs/{ticketNumber}/assign-workers` เลือก Worker ใหม่ที่ `ready` ในคิวให้รับงานเอง (ไม่เกิน `WorkersRequired` และรถต้องยังมีแผงที่ยังไม่จบ) บันทึก `MANUAL_ASSIGNMENT` ลง admin_action_logs จากนั้น Worker กดรับและสแกนตาม flow ปกติ (รายละเอียดดูหัวข้อ Admin จัดการทีม)

---

## Step 3: Worker กด Accept งาน

`POST /api/workers/me/assignments/{ticketNumber}/accept`

- ต้องกดภายใน `accept_deadline_at` ไม่งั้นระบบ (BullMQ job) จะเรียก `handleAssignmentAcceptTimeout` ให้เอง: นับ `accept timeout streak`, ถ้ายังไม่ถึง limit (`worker_accept_timeout_limit`) จะ requeue กลับเข้าคิว, ถ้าถึง limit จะปิดกะให้ (`closeWorkerShift`) แล้วส่งกลับ `open_app`
- กด Accept สำเร็จ: บันทึกเวลา `accepted_at`, ตั้ง `scan_deadline_at` ใหม่ (สำหรับขั้นตอน check-in), ตั้ง BullMQ job คู่ scan-timeout + scan-warning (แจ้งเตือน Admin ก่อนหมดเวลาจริงตาม `worker_scan_warning_before_minutes`)

---

## Step 4: Worker สแกน QR Check-in เข้างาน

`POST /api/workers/me/assignments/check-in-barcode` — สแกนบาร์โค้ด `ticket_no` ที่พิมพ์บนตั๋วกระดาษของด่าน (ไม่ใช่ QR ของ `Qr.DriverQrToken` ใน Step 1 ซึ่งใช้เฉพาะฝั่ง Driver)

- ถ้าไม่สแกนก่อน `scan_deadline_at` หมด → BullMQ scan-timeout job จะ mark assignment เป็น `TIMEOUT`, ปลด Worker กลับ `open_app`, แจ้งเตือนผ่าน WebSocket/SSE และระบบหาคนแทนจากคิว
- ก่อนหมดเวลา `worker_scan_warning_before_minutes` นาที Admin ได้รับแจ้งเตือน และขยายเวลาได้ที่ `POST /api/admin/vehicle-jobs/{ticketNumber}/scan-deadline/extend` (event `ASSIGNMENT_SCAN_DEADLINE_EXTENDED`)
- สแกนทันเวลา → assignment เปลี่ยนเป็น `SCANNED` (สถานะคิวของ Worker เป็น `waiting_team`) และระบบเช็คความพร้อมทีมด้วย `getTicketJobTeamScanReadiness` ทุกครั้ง
- `ticket_no` ต้องเป็นของรถคันที่ Worker ได้รับงานเท่านั้น
- คนแรกที่สแกน: ระบบย่อ `scan_deadline_at` ของคนที่เหลือเหลือ `worker_scan_team_remaining_minutes` (event `ASSIGNMENT_SCAN_DEADLINE_SHORTENED`)
- จำนวนที่ต้องสแกนครบ = `workers_required` ลบช่องที่ยังไม่ได้เติม (`unfilled_slot_count` = คนที่ Admin ถอดออกหลังสแกน + จำนวนที่ Gate เพิ่มหลังทีมเริ่มงาน)

---

## Step 5: ทีมพร้อมครบ (TEAM_READY) และเริ่มทำงาน

เมื่อทีมสแกนเข้างานครบ ระบบเรียก `markTicketJobInProgress` บันทึก `work_started_at` (ครั้งแรกเท่านั้น) และเปิดแผงถัดไปให้ทำ (`activateNextTicketIfReady` — Business Ticket/แผงเป็น `WORKING`) แล้วส่ง WebSocket event `TEAM_READY` ให้ทุกคนในทีม (พร้อม FCM push) — ตั้งแต่จุดนี้ Worker ถือว่าเริ่มทำงานจริง คนที่ Admin เพิ่มมาแทนหลังทีมพร้อมแล้วได้ `TEAM_READY` เฉพาะตัวเองตอนสแกน ทีมเดิมไม่ได้ซ้ำ

---

## Step 6: Worker ส่งยอดสินค้า (Ticket Completion Submit)

`POST /api/workers/me/assignments/tickets/complete` (หรือ Admin ส่งแทนที่ `POST /api/admin/vehicle-jobs/{ticketNumber}/tickets/{ticketNo}/stalls/{stallCode}/override-count`)

- ตรวจว่าสินค้าที่ส่งมาครบทุกชิ้นของ Booth นั้น (`validateTicketCompletionItems`) ProductCode ห้ามสลับ แต่เปลี่ยน PackageCode ได้ (ต้องคำนวณ Rate Snapshot ใหม่เสมอ ห้ามใช้ Rate เดิม) — Worker ดู PackageCode ที่เลือกได้จาก `GET /api/workers/me/products/{productCode}/packages`
- ทีมต้องสแกนครบก่อนส่งยอด (`WORKERS_NOT_CHECKED_IN`) และแผงต้องมี LINE ของ Vendor ผูกไว้ (`TICKET_VENDOR_LINE_NOT_CONFIGURED`)
- ระบบ snapshot รายชื่อสมาชิกของแผงในรอบส่งยอดนี้ (Worker ส่งเองและ Admin ส่งแทนใช้ชุดเดียวกัน) — รายชื่อนี้คือกลุ่มที่ได้ค่าแรงของแผงถ้า Vendor ยืนยัน
  - แผงที่ยังไม่เคยส่งยอด: คนที่ `WORKING` ตอนส่ง ไม่รวมคนที่ถูกถอดออกจากแผง
  - แผงที่ถูกตีกลับ (`REJECT`): รายชื่อรอบก่อน ลบคนที่ถูกถอดแบบไม่ให้เงิน บวกคนที่ Admin เลือกเข้าแผง (`booth_job_worker_inclusions`) ที่สแกนแล้ว คนที่ถูกถอดแบบให้เงินยังอยู่ในรายชื่อ ส่วนคนใหม่บนรถไม่ได้เข้าแผงนี้ถ้า Admin ไม่ได้เลือก
- Worker ส่งยอดได้เฉพาะแผงที่ตัวเองเป็นสมาชิก (`WORKER_NOT_IN_BOOTH`) และถ้ามีคนที่ถูกเพิ่มเข้ามาและจะเป็นสมาชิกของแผงนี้แต่ยังไม่สแกน ต้องรอเขาสแกนก่อน (`WAITING_REPLACEMENT_SCAN` พร้อม `WorkerCodes`) แผงที่ไม่มีสมาชิกเหลือส่งยอดไม่ได้ (`BOOTH_HAS_NO_MEMBERS`)
- การส่งยอด lock แถว `booth_jobs` ก่อนตรวจสถานะ จึงไม่ชนกับ Gate แก้ตั๋ว หรือ Admin ถอดคน/ยกเลิกแผงพร้อมกัน
- Admin ส่งแทนได้เฉพาะแผงที่เคยมี Worker ส่งยอดมาแล้ว (ปกติคือแผงที่ถูกตีกลับ) และทีมต้องสแกนครบ (รวมทีมที่ release แล้ว) ค่าแรงของรอบนี้หารให้สมาชิกปัจจุบันของแผงตามกฎข้างบน ไม่เช่นนั้นคืน 409 `ADMIN_SUBMIT_REQUIRES_WORKER_SUBMISSION` / `WORKERS_NOT_CHECKED_IN`
- Booth เปลี่ยนเป็น `DELIVERED` รอ Vendor ยืนยัน — ระบบส่ง LINE Flex Message ไปหา Vendor ทุกคนที่ผูกกับแผง (เจ้าของแผงและลูกน้องแผง) พร้อม postback token คู่ confirm/reject (`buildVendorCompletionPostbackData`) และตั้ง BullMQ job `vendor-confirm-timeout` (auto-confirm ถ้า Vendor เงียบเกิน `vendor_confirm_timeout_minutes`, หรือ `vendor_reconfirm_timeout_minutes` ถ้าเป็นรอบส่งใหม่หลัง reject) — deadline = `max(เวลาส่งยอด, updated_at ของ setting) + timeout` ถ้า Admin แก้ค่า timeout ทุกแผงที่รออยู่จะเริ่มนับใหม่จากเวลาแก้ (ตั้ง job ใหม่ทันที และ sweep ทุก 2 นาทีตัดแผงที่เลย deadline ตาม config ปัจจุบันเป็นตัวสำรอง)
- ถ้า Worker คนที่ส่งหมดกะไปแล้วตอนนี้พอดี ระบบจะย้ายกลับ `open_app` ให้ทันที และถ้าทุก Booth ของคันนี้ถูกจัดการครบ (ส่งยอด/ยืนยัน/ยกเลิก) พร้อมกับ Worker ทั้งทีมหมดกะไปแล้วทุกคน (ไม่ใช่แค่บางคน) ระบบจะปล่อยทั้งทีมกลับคิวให้อัตโนมัติ (`autoReleaseTicketJobWorkersIfShiftEnded`) โดยไม่ต้องรอ Admin กด release-workers

---

## Step 7: Vendor ยืนยัน/ปฏิเสธผ่าน LINE (หรือ Auto-confirm / Admin แทน)

`POST /api/line/webhook` (LINE postback) — เทียบ signature ก่อน (HMAC SHA-256 ด้วย `LINE_CHANNEL_SECRET`) แล้ว verify action token (`vendor_confirm_completion` / `vendor_reject_completion`) ผ่าน `applyVendorTicketCompletionResult` (`src/services/shared/ticket-completion.service.ts`) — ใช้ path เดียวกันไม่ว่าจะยืนยันจาก LINE จริง, `/api/line/dev/submissions/{id}/confirm|reject` (เครื่องมือ dev สำรองเมื่อ LINE Messaging API ติด rate limit), หรือ auto-confirm ตอน timeout

- **Confirm**: ลบ BullMQ vendor-confirm-timeout job ที่ค้างไว้ (กันยิงซ้ำ), Booth เป็น `COMPLETED` และบันทึก snapshot ตัวหารค่าแรงของแผงจากรายชื่อของรอบส่งยอดที่ถูกยืนยัน (ไม่รวมคนที่ถูกถอดออกจากแผงนั้น; Worker ที่ถูกถอดออกจากงานหลังส่งยอดยังได้เงิน เว้นแต่ Admin เลือกไม่ให้เงินแผงนั้น) จากนั้นเรียก `closeCompletedTicketJobIfReady` (ดู Step 8) ถ้างานรถยังไม่จบเรียก `activateNextTicketIfReady` เปิดแผงถัดไป และ assignment กลับเป็น `WORKING`
- **Reject**: Booth และ assignment เป็น `REJECT` Worker/Admin ส่งยอดใหม่ได้อีกครั้ง รอบใหม่ snapshot รายชื่อตามกฎแผงที่ถูกตีกลับข้างบน (timeout รอบใหม่ใช้ `vendor_reconfirm_timeout_minutes` ที่สั้นกว่ารอบแรก)
- Worker (เฉพาะคนที่ยังอยู่ในทีม) และ Admin ได้รับ event `TICKET_COMPLETION_RESULT` (WebSocket/SSE) ไม่ว่าผลจะมาจาก LINE จริงหรือ auto-confirm timeout
- Postback ที่มาหลังรายการถูกจัดการไปแล้ว (เช่น auto-confirm ชนะไปก่อน) ระบบตอบ Vendor ว่า "รายการนี้ถูกจัดการแล้ว" และประมวลผล event อื่นต่อ
- **ให้คะแนน**: หลัง Vendor ยืนยันผ่าน LINE ระบบส่งข้อความยืนยันสำเร็จและ Flex Message ให้คะแนน (`vendor_rate_ticket`) ให้คนที่กดยืนยัน ถ้าเป็น auto-confirm ตอน timeout ระบบส่งข้อความ "ระบบยืนยันข้อมูลอัตโนมัติ" และปุ่มให้คะแนน (token แยกรายคน) ให้ทุก LINE ของแผง (เจ้าของและสมาชิก)
- แผงเก็บคะแนนได้ 1 ครั้ง (`ticket_ratings` unique ต่อแผง) คะแนนของแผง = ของคนแรกที่กด คนแรกได้ข้อความขอบคุณพร้อมสรุปค่าใช้บริการ และทุกคนในแผงได้สรุปค่าใช้บริการ (`send_vendor_ticket_payment_summary`) คนที่กดทีหลังคะแนนไม่ถูกบันทึกและระบบไม่ตอบกลับ (ได้สรุปไปแล้วตอนคนแรกให้คะแนน) ยอดคือ `booth_jobs.final_stall_amount` ที่คิดไว้ตอนยืนยัน จึงไม่ต้องรอปิดยอดทั้งใบ

---

## Step 8: ปิดงาน (Financialize) และ Worker กลับเข้าคิว

`closeCompletedTicketJobIfReady` (`src/services/shared/ticket-job-lifecycle.service.ts`) ถูกเรียกทุกครั้งที่แผงจบ (confirm หรือยกเลิก):

1. **ปิดยอดราย Business Ticket**: ใบไหนทุกแผงจบแล้ว (`COMPLETED`/`CANCELLED`) และมีแผง `COMPLETED` → `finalizeMarketJobFinancials` lock roster และคำนวณเงินของทุก Product/Worker ตาม snapshot ตัวหารของแต่ละแผง ใช้ Rate Snapshot ที่บันทึกไว้ (ไม่คำนวณใหม่จาก Master Rate ปัจจุบัน) ถ้าทุกแผงถูกยกเลิกหมด ใบนั้นเป็น `CANCELLED`
2. **ปิดงานรถ**: เมื่อทุก Business Ticket จบและปิดรับ Ticket เพิ่มแล้ว (`tickets_closed_at`) งานรถเป็น `COMPLETED` (หรือ `CANCELLED` ถ้าทุกใบถูกยกเลิก) revoke Driver session, assignment ที่สแกนแล้วเป็น `COMPLETED` ส่วนที่ยังไม่สแกนเป็น `CANCELLED` — ถ้างานรถปิดเป็น `CANCELLED` (Admin ยกเลิกตลาด/แผงจนหมดแทนการยกเลิกทั้งคัน) คนที่สแกนแล้วก็เป็น `CANCELLED` ด้วย (event `ADMIN_CANCELLED` source `vehicle_job_cancelled_by_cascade` ไม่ใช่ `COMPLETED`) แล้วคืนคิวพร้อมแจ้ง Worker `ASSIGNMENT_CANCELLED` (reason `vehicle_job_cancelled`) และ Admin `WORKER_STATUS_CHANGED` (reason `vehicle_job_cancelled_requeue` / `vehicle_job_cancelled_not_available`) ประวัติงานแสดงเหตุผลยกเลิกจาก log ยกเลิกตลาด/แผงล่าสุดของ Admin
3. `returnCompletedWorkersToQueue` พา Worker แต่ละคนกลับเข้าคิว FIFO ถ้ายังอยู่ในกะ (หรือ `open_app` ถ้าหมดกะแล้ว) แล้วเรียก `dispatchReadyWorkers()` ซ้ำทันทีให้คันอื่นที่รออยู่ได้ Worker ต่อ
4. Admin ที่ต้องการปล่อย Worker กลับคิวก่อนที่ Vendor จะยืนยันครบ (เช่น รอ Vendor เซ็นรับของอยู่) ใช้ `POST /api/admin/vehicle-jobs/{ticketNumber}/release-workers` ได้ — ต้องส่งยอดครบทุกแผงก่อน งานรถจะเป็น `RELEASED` (ไม่ใช่ `COMPLETED`) Worker ออกจากงานได้แต่ Booth ยังไม่ปิดจนกว่า Vendor จะยืนยันจริง
   - Assignment เป็น `RELEASED` + `released_at` และ Worker กลับคิวทันที งานใหม่เป็น assignment แถวใหม่ ไม่ติดสถานะจากงานเก่า
   - ระหว่างรอ Worker ยังอยู่ใน roster จึงได้ `TICKET_COMPLETION_RESULT` (socket + FCM) ทุกครั้งที่ Vendor ยืนยัน/ตีกลับ หรือระบบตัดยืนยันเมื่อครบเวลา (`ticket.completion_auto_confirmed`) โดย payload ของคนที่ release แล้วมี `assignment_status: RELEASED` และถ้าถูกตีกลับยังส่งยอดใหม่ได้
   - เมื่องานรถปิด (ข้อ 2) assignment ที่ `RELEASED` เปลี่ยนเป็น `COMPLETED` + `completed_at` (คง `released_at`) และบันทึก event `COMPLETED` แต่**ไม่**อยู่ใน `completed_worker_ids` จึงไม่ถูกคืนเข้าคิวซ้ำ (ถ้ารถปิดเป็น `CANCELLED` จะเป็น `CANCELLED` ตามรถ — ปัจจุบันเกิดไม่ได้เพราะห้ามยกเลิกหลังส่งยอด)

---

## การคำนวณจำนวน Worker และเงิน

สูตรอยู่ที่ `src/utils/labor-job-pricing.ts` และ `src/services/shared/ticket-financial.service.ts` คำนวณด้วย `Prisma.Decimal` ทั้งหมด (ไม่ใช้ floating point)

### 1. จำนวน Worker ที่ต้องใช้ (ตอน Gate สร้าง Ticket)

1. สินค้าแต่ละรายการเลือกจำนวน Worker จาก `workerRanges` ของ Master Product ตามจำนวน (`Quantity`):

| จำนวนสินค้า | ใช้ค่า |
| --- | --- |
| 1–50 | `range1To50` |
| 51–100 | `range51To100` |
| 101–200 | `range101To200` |
| 201–400 | `range201To400` |
| 401–600 | `range401To600` |
| มากกว่า 600 | `rangeOver600` |

2. Business Ticket: `workers_required` = **MAX** ของทุกสินค้าทุกแผงในใบนั้น (เพิ่มแผงเข้าใบเดิม = MAX ระหว่างค่าเดิมกับค่าใหม่)
3. งานรถ: `workers_required` = **ผลรวม** ของ `workers_required` ทุก Business Ticket ที่ยัง active

### 2. การเลือก Rate (Rate Snapshot)

1. หา `packageWeight` จาก Master Product ที่ตรงทั้ง `ProductCode` + `PackageCode`
2. หา Master Rate ของตลาด (`MarketCode`) ที่ `weight_min < packageWeight ≤ weight_max` ถ้าไม่มี ใช้ Rate กลาง (`MarketCode = "0000"`) ถ้าไม่เจอเลยคืน 409 `RATE_NOT_FOUND` และถ้าเจอมากกว่า 1 แถวคืน 409 `DUPLICATE_RATE_CONFIGURATION`
3. บันทึก `stall_rate_snapshot` (ค่าแผงต่อหน่วย) และ `labor_rate_snapshot` (ค่าแรงต่อหน่วย) ลง `ticket_products` ตั้งแต่ Gate สร้าง Ticket และหาใหม่เฉพาะเมื่อ Worker เปลี่ยน `PackageCode` ตอนส่งยอด — Master Rate ที่แก้ภายหลังไม่มีผลกับงานที่สร้างไปแล้ว

### 3. ค่าลงสินค้าของแผง (ต่อสินค้า 1 รายการ)

ใช้ `confirmed_quantity` (จำนวนที่ Vendor ยืนยัน) เท่านั้น ไม่ใช้จำนวนจาก Gate

| ค่า | สูตร |
| --- | --- |
| `stall_fee_raw` | `confirmed_quantity × stall_rate` |
| `stall_fee_rounded` | `CEIL(stall_fee_raw)` |
| `labor_fee_raw` | `confirmed_quantity × labor_rate` (ไม่ปัด) |
| `product_charge` (ยอดที่เก็บจากแผง) | `CEIL(stall_fee_rounded + labor_fee_raw)` |

- คิดทันทีตอนแผงถูกยืนยัน (Vendor กดยืนยัน หรือ timeout ยืนยันอัตโนมัติ) ไม่ต้องรอแผงอื่น เพราะไม่ขึ้นกับจำนวน Worker
- บันทึก 4 ค่าข้างบนลง `ticket_products` และยอดของแผง (`booth_jobs.final_stall_amount`) = ผลรวม `product_charge` ของทุกสินค้าในแผง
- ยอดของ Business Ticket (`market_jobs.final_stall_amount`) = ผลรวม `booth_jobs.final_stall_amount` ของทุกแผงที่ `COMPLETED` (รวมตอนปิดยอดทั้งใบ)

### 4. ค่าแรง Worker และเงินกองทุน (ต่อสินค้า 1 รายการ)

คิดตอนปิดยอดทั้งใบ (ทุกแผงจบแล้ว) โดยใช้ `labor_fee_raw`, `stall_fee_rounded` และ `product_charge` ที่บันทึกไว้ใน `ticket_products` ตอนยืนยัน ไม่คิดยอดแผงซ้ำ

`จำนวน Worker` = จำนวนคนใน snapshot ตัวหารของแผงนั้น (ดู Step 7) ลบคนที่ Admin ถอดออกจากแผงภายหลัง และทุกแผงที่ยืนยันแล้วต้องเหลือคนได้เงินอย่างน้อย 1 คน

| ค่า | สูตร |
| --- | --- |
| `raw_amount` ต่อคน | `labor_fee_raw ÷ จำนวน Worker` |
| `final_amount` ต่อคน (เงินที่ได้จริง) | `FLOOR(raw_amount)` — จ่ายเฉพาะบาทเต็ม |
| `remainder_amount` ต่อคน | `raw_amount − final_amount` |
| `worker_payout_total` | `final_amount × จำนวน Worker` |
| `fund_amount` (เข้ากองทุน) | `(labor_fee_raw − worker_payout_total) + (product_charge − stall_fee_rounded − labor_fee_raw)` |

- ยอดรวมต้องตรงกันเสมอ: `product_charge = stall_fee_rounded + worker_payout_total + fund_amount`
- บันทึกผลต่อสินค้าใน `ticket_product_financials` และเงินรายคนใน `ticket_worker_payments` ส่วนรายได้ของ Worker ต่อ Business Ticket (`ticket_workers.final_earning_amount`) = ผลรวม `final_amount` ของทุกสินค้าในทุกแผงที่คนนั้นอยู่ใน snapshot
- บันทึกสีเสื้อของกลุ่มที่หารเงิน (`shirt_color_snapshot`): สีเดียวกันทั้งกลุ่ม = สีนั้น, ต่างกัน = `MIXED`, ไม่มีข้อมูล = `UNKNOWN` ใช้ในรายงานค่าลงสินค้าแผงค้า
- ถ้า Admin เปลี่ยนคนได้เงินของแผงหลังปิดยอดทั้งใบแล้ว (`refinalizeBoothWorkerPayments`) ระบบคิด `ticket_product_financials` / `ticket_worker_payments` ของแผงนั้นใหม่ตามคนที่เหลือ และคิด `ticket_workers.final_earning_amount` ของทุกคนในใบใหม่ (คนที่ไม่เหลือยอดเป็น 0) ยอดที่เก็บจากแผง (`product_charge`, `final_stall_amount`) ไม่เปลี่ยน ส่วนต่างจากการปัดเศษเข้ากองทุนตามสูตรเดิม

### 5. ตัวอย่าง

สินค้า 1 รายการ `confirmed_quantity = 4`, `stall_rate = 1.50`, `labor_rate = 0.90`, snapshot ของแผงมี Worker 2 คน

| ค่า | การคำนวณ | ผล |
| --- | --- | --- |
| `stall_fee_raw` | 4 × 1.50 | 6.00 |
| `stall_fee_rounded` | CEIL(6.00) | 6 |
| `labor_fee_raw` | 4 × 0.90 | 3.60 |
| `product_charge` | CEIL(6 + 3.60) | 10 |
| `raw_amount` ต่อคน | 3.60 ÷ 2 | 1.80 |
| `final_amount` ต่อคน | FLOOR(1.80) | 1 |
| `worker_payout_total` | 1 × 2 | 2 |
| `fund_amount` | (3.60 − 2) + (10 − 6 − 3.60) | 2.00 |

ตรวจยอด: 6 (ค่าแผง) + 2 (Worker) + 2 (กองทุน) = 10 = `product_charge`

---

## Admin จัดการทีมและงานระหว่างทำงาน

`POST /api/admin/vehicle-jobs/assignment/cancel` — ขอบเขตขึ้นกับ field ที่ส่งมา: `TicketNumber` อย่างเดียว = ยกเลิกทั้งคัน, `+ TicketNo` = ทั้ง Business Ticket, `+ TicketNo + BoothCode` = แผงเดียว, `+ WorkerCode` = ถอด Worker ออกจากทั้งคัน / Business Ticket / แผง ตามลำดับ

- **ถอด Worker ออกจากทั้งคัน** (`+ WorkerCode`): ทำได้แม้ Worker ส่งยอดแล้ว ถูก release แล้ว หรือรถปิดแล้ว (รถปิดแล้วต้องยังอยู่ในกะของ Worker คนนั้น ไม่งั้นตอบ `REMOVAL_WINDOW_CLOSED`)
  - Admin เลือกสิทธิ์เงินรายแผงด้วย `BoothPayouts: [{ TicketNo, BoothCode, Paid }]` เฉพาะแผงที่มีชื่อ Worker ในรายชื่อส่งยอด (`DELIVERED`/`REJECT`/`COMPLETED`) แผงที่ไม่ได้ส่งมาถือว่าให้เงิน ส่วนแผงที่ยังไม่ส่งยอดไม่ได้เงินเสมอ หน้า UI ดึงรายการแผงจาก `GET /api/admin/vehicle-jobs/{ticketNumber}/workers/{workerCode}/payout-preview`
  - แผงที่ไม่ให้เงิน: ไม่นับ Worker คนนั้นเป็นตัวหาร (`booth_job_worker_exclusions`) ถ้าแผงปิดยอดแล้วระบบคิดเงินใหม่ทันที (ยอดที่เก็บจากแผงไม่เปลี่ยน) แผง `DELIVERED`/`COMPLETED` ต้องเหลือคนได้เงินอย่างน้อย 1 คน (`BOOTH_MIN_ONE_WORKER`) ส่วนแผงที่ยังไม่จบแล้วไม่เหลือคนถูกยกเลิกอัตโนมัติ (บันทึกรายชื่อเดิมลง metadata ของ log ยกเลิกแผง)
  - ยังไม่สแกน: ระบบหาคนแทนจากคิวทันที / สแกนแล้ว: ไม่หาคนแทน (`unfilled_slot_count` +1) และต้องไม่ใช่คนที่สแกนแล้วคนสุดท้ายบนรถ (`LAST_WORKER_ON_VEHICLE` ให้เพิ่มคนแทนก่อนหรือยกเลิกทั้งรถ)
  - คนที่ release แล้วหรือรถปิดแล้ว: assignment เป็น `CANCELLED` (รถปิดแล้วและยังได้เงินบางแผงคง `COMPLETED`) โดยไม่แตะสถานะคิวปัจจุบัน และได้แจ้ง `WORKER_REMOVED_FROM_VEHICLE_JOB` ครั้งเดียว
  - Worker ที่ถูกถอดไม่ได้รับแจ้งเตือนของงานนี้อีก Admin ได้ SSE `WORKER_PAYOUT_RECALCULATED` ทุกครั้งที่คิดเงินแผงใหม่
- **ถอด Worker ออกจาก Business Ticket** (`+ TicketNo + WorkerCode`): กฎเดียวกับถอดทั้งคันแต่เฉพาะแผงในใบนั้น (เลือก `BoothPayouts` ได้) roster ของใบเป็น `CANCELLED` ถ้าใบนั้นเป็นงานสุดท้ายของ Worker บนรถ ระบบยกเลิก assignment ด้วย
- **ถอด Worker ออกจากแผงเดียว** (`+ TicketNo + BoothCode + WorkerCode`): ไม่ได้เงินแผงนั้น (roster ไม่เปลี่ยน) ทำได้ทุกสถานะแผงที่ยังไม่ถูกยกเลิก ใช้กฎขั้นต่ำ 1 คน / ยกเลิกแผงอัตโนมัติ / คิดเงินใหม่ แบบเดียวกัน ถ้าไม่เหลืองานบนรถ ระบบยกเลิก assignment ด้วย
- ทุกการถอดบันทึก `admin_action_logs` พร้อม `metadata.booth_payouts` (สถานะแผง, ให้เงินหรือไม่, รายชื่อคนได้เงินก่อน/หลัง, แผงที่ถูกยกเลิก และผลคิดเงินใหม่ก่อน/หลัง)
- **History**: Worker ที่ถูกถอดจากรถแต่ยังได้เงินบางแผงแสดง `FinalStatus = COMPLETED` (ยังมี `Cancellation` บอกผู้ถอดและเหตุผล) ส่วน `SubmissionWorkerSnapshot` ของแต่ละแผงมี `Status` (`PAID` / `CANCELLED`) และ `Cancellation` ของคนที่ถูกถอดแบบไม่ให้เงิน รายงานรายได้รายวันมีหมายเหตุ "Admin ถอดออกจากแผงที่ส่งยอดแล้ว (ไม่ให้เงินแผงนั้น)"
- **ผู้รับแจ้งเตือนของแผง** (ส่งยอด/ผลยืนยัน/ตีกลับ): เฉพาะสมาชิกของแผงที่ยังไม่ถูกถอดออกจากงาน คนที่ถูกถอดจากแผงหรือจากรถ และคนบนรถที่ไม่ได้ถูกเลือกเข้าแผงที่ถูกตีกลับ จะไม่ได้รับ
- **เพิ่ม Worker ใหม่**: `POST /api/admin/vehicle-jobs/{ticketNumber}/assign-workers` ได้ไม่เกิน `WorkersRequired` และรถต้องยังมีแผง `WAIT`/`WORKING`/`REJECT` (`NO_UNFINISHED_BOOTH`) Worker ต้องกดรับและสแกนตาม flow ปกติ
  - ก่อนทีมสแกนครบรอบแรกระบบเรียกคนจากคิวเอง หลังจากนั้นช่องที่ว่าง (ถอดคนที่สแกนแล้ว หรือ Gate เพิ่มคน) Admin เป็นคนเลือก assignment ที่เติมช่องว่างมี `fills_removed_slot = true` สแกนแล้วคืนช่อง (`unfilled_slot_count` -1) ทีมไม่ถูกย้อนสถานะและได้ `TEAM_READY` เฉพาะคนที่เพิ่งสแกน ถ้าหมดเวลากดรับ/สแกน ระบบไม่หาคนแทนและแจ้ง Admin `REPLACEMENT_WORKER_TIMEOUT`
  - คนใหม่เข้าทุกแผงที่ยังไม่ส่งยอดอัตโนมัติ (ทีมได้แจ้ง `TEAM_WAITING_REPLACEMENT` และแผงนั้นรอเขาสแกนก่อนส่งยอด) ส่วนแผงที่ถูกตีกลับ Admin ต้องเลือกใน `BoothMemberships` และแผงต้องไม่เกิน `WorkersRequired` (`BOOTH_MEMBER_LIMIT_EXCEEDED`)
  - Worker ทุกคนที่เพิ่มต้องมีงานอย่างน้อย 1 แผง: ถ้ารถเหลือแต่แผงที่ถูกตีกลับ ทุกคนใน `WorkerCodes` ต้องถูกเลือกใน `BoothMemberships` อย่างน้อย 1 แผง ไม่งั้นตอบ 409 `WORKER_BOOTH_REQUIRED` พร้อม `WorkerCodes` และ `AvailableBooths[]` (TicketNo, BoothCode, RemainingSeats) และไม่บันทึกอะไรเลย กันไม่ให้มีคนอยู่บนรถโดยไม่มีงานและไม่ได้เงิน
  - คนที่เคยทำงานบนรถนี้เพิ่มแบบคนใหม่ไม่ได้ (`WORKER_PREVIOUSLY_ON_VEHICLE`) ต้องนำกลับด้วยหัวข้อถัดไป
- **นำ Worker เข้าแผงที่เลือก**: `POST /api/admin/vehicle-jobs/{ticketNumber}/workers/{workerCode}/booths` (permission `jobs:cancel`) ใช้นำคนที่ถอดผิดกลับ หรือเลือกคนบนรถเข้าแผงที่ถูกตีกลับ ทุกเงื่อนไขต้องผ่านทั้งคำขอ
  - แผง `DELIVERED`/`COMPLETED`: นำกลับได้เฉพาะคนที่อยู่ในรายชื่อส่งยอดแล้วถูกถอด ได้เงินคืนทันที (ปิดยอดแล้วคิดเงินใหม่) ไม่ต้องสแกน ไม่นับใน `WorkersRequired`
  - แผงที่ยังไม่จบ: ถ้า Worker ไม่มีงานบนรถจะได้ assignment ใหม่ (ต้อง `ready` ในคิว อยู่ในกะ ไม่มีงานอื่น และรถยังมีช่อง) ต้องกดรับและสแกน roster ของใบนั้นกลับเป็น `WORKING` และแผงที่ยังไม่ส่งยอดซึ่งไม่ได้เลือกจะไม่นับเขา
  - แผงที่ถูกยกเลิกแล้วนำกลับไม่ได้ บันทึก `BOOTH_MEMBERS_ADDED` ลง `admin_action_logs` และแจ้ง `BOOTH_MEMBERS_CHANGED`
- ยกเลิกทั้งคัน / ทั้ง Business Ticket / แผง ได้เมื่อทุกแผงในขอบเขตเป็น `WAIT`/`WORKING`/`REJECT`/`CANCELLED` ถ้ามีแผง `DELIVERED` หรือ `COMPLETED` ตอบ 409 (`VEHICLE_JOB_ALREADY_SUBMITTED` / `MARKET_JOB_ALREADY_SUBMITTED` พร้อม `BoothCodes`, `STALL_JOB_ALREADY_SUBMITTED` / `STALL_JOB_ALREADY_CLOSED`) และรถที่ Admin ปล่อยทีมแล้วยกเลิกไม่ได้ (`VEHICLE_JOB_RELEASED`)
- แผงที่ Vendor ตีกลับ (`REJECT`) ยกเลิกได้ ถ้ายกเลิกแล้วรถไม่เหลือแผง `REJECT` assignment ที่ค้าง `REJECT` กลับเป็น `WORKING` การยกเลิกคำนวณสถานะของใบ/งานรถใหม่ผ่าน `closeCompletedTicketJobIfReady` เสมอ
- ทุก action ของ Admin ที่บันทึกลง `admin_action_logs` (ยกเลิก/ถอด/เพิ่มคน/นำคนกลับ/ส่งยอดแทน/เปิด-ปิด dispatch/ปล่อยทีม/ต่อเวลา scan/บังคับสถานะ Worker) ต้องส่งทั้ง `ReasonCode` และ `ReasonText` ไม่ครบตอบ 400

เครื่องมือ Admin อื่นระหว่างทำงาน:

| API | ใช้ทำอะไร |
| --- | --- |
| `GET /api/admin/jobs/workers/status` | สถานะ Worker ในกะ ลำดับคิว และสถานะ WebSocket |
| `POST /api/admin/jobs/workers/{workerCode}/status/force` | บังคับสถานะ Worker (`open_app` ทำได้เสมอ, `ready`/`break` ต้องเปิด WebSocket อยู่) |
| `GET /api/admin/vehicle-jobs/operations` | รายการงานรถสำหรับหน้าปฏิบัติการ |
| `GET /api/admin/vehicle-jobs/history` | ประวัติงานรถ, Timeline และ Worker ของแต่ละคัน |
| `GET /api/admin/vehicle-jobs/{ticketNumber}/financials` | รายละเอียดการเงินของงานรถ |
| `GET /api/admin/vehicle-jobs/history/daily-worker-income` | รายได้รายวันของ Worker |
| `GET /api/admin/vehicle-jobs/history/daily-stall-fees`, `/monthly-stall-fees` | รายงานค่าลงสินค้าแผงค้า รายวัน/รายเดือน |
| `GET /api/admin/audit/events`, `/audit/workers/performance` | Audit timeline และสถิติการรับงานของ Worker |

---

## Driver Web

1. Driver สแกน QR ของรถ (`Qr.DriverQrToken` จาก Step 1) → `POST /api/driver/qr-sessions` ส่ง DeviceId ได้ session token อายุ `driver_session_ttl_hours` (ไม่เกิน 2 เครื่องต่อคัน เครื่องเดิมสแกนซ้ำจะ rotate session)
2. `GET /api/driver/jobs/current` ดูงานรถพร้อม `operation_status` ที่ server คำนวณให้ (Frontend ห้ามคำนวณเอง)
3. `POST /api/driver/jobs/{ticketNumber}/ready` แจ้งรถพร้อมลงสินค้า (เฉพาะตอน `operation_status` เป็น `WAIT`) งานรถเป็น `WORKING` และเริ่ม dispatch
4. `GET /api/driver/jobs/stream` (SSE) รับ `DRIVER_JOB_SNAPSHOT` ตอนเชื่อมต่อ, `DRIVER_JOB_UPDATED` เมื่อข้อมูลเปลี่ยน และ `DRIVER_JOB_TERMINAL` ก่อนปิด stream
5. เมื่องานรถ `COMPLETED`/`CANCELLED` session ถูก revoke แต่ยังอ่านข้อมูลได้ช่วง grace (`DRIVER_TERMINAL_SESSION_GRACE_MINUTES`)

---

## Auth และ Session

- Login ได้ access token + refresh token ผูกกับ session ของอุปกรณ์ ถ้ามี session ใช้งานอยู่บนเครื่องอื่นต้องยืนยัน force login
- `POST /api/auth/refresh` rotate refresh token ทุกครั้ง เรียกเมื่อได้ header `X-Should-Refresh: true` หรือ event `TOKEN_NEARING_EXPIRY`
- Session มีอายุสูงสุดนับจาก login (Worker 7 วัน / Admin 24 ชั่วโมง) refresh ไม่ต่ออายุ
- `POST /api/auth/logout` หรือ Admin ปิดใช้งานบัญชี/รีเซ็ตรหัสผ่าน จะ revoke session และตัด WebSocket ทันที (`SESSION_REVOKED`)
- Admin ถูกแก้สิทธิ์/ปิดบัญชี/รีเซ็ตรหัสผ่าน หรือเปลี่ยนรหัสผ่านเอง (session อื่นถูก revoke) ระบบปิด SSE ของ session ที่ถูก revoke ทุกแท็บทันที พร้อม event `SESSION_REVOKED`
- Worker force login หรือ login ซ้ำจากเครื่องเดิม ระบบส่ง `SESSION_REVOKED` และตัดเฉพาะ socket ของ session เก่า เครื่องใหม่ไม่ถูกแตะ
- **รหัสผ่านของ Worker คือเบอร์โทรศัพท์ (ตัวเลขล้วน) โดยตั้งใจ** เพื่อให้แรงงานจำได้ง่าย ไม่ถือเป็น bug ตอนตรวจ security ระบบป้องกันการเดาด้วย rate limit ต่อ IP ของกลุ่ม `/api/auth/*` เท่านั้น ไม่มีการล็อกบัญชีเมื่อใส่ผิดหลายครั้ง
- บัญชีที่ถูกปิดใช้งาน (Admin หรือ Worker) login แล้วได้ 401 `INVALID_CREDENTIALS` เหมือนรหัสผิด ไม่บอกว่ารหัสผ่านถูก ส่วน username ของ Admin กับรหัส Worker ห้ามซ้ำกัน (409) เพราะ login หา Admin ก่อน
- สิทธิ์ของ Admin ตรวจด้วย permission ต่อ endpoint (เช่น `jobs:read`, `jobs:cancel`) ตั้งค่าที่ Admin Settings

---

## Concurrency — การจัดการ concurrency ในระบบ

ระบบมี Worker/Admin หลายคนยิง request พร้อมกันตลอดเวลา (Dispatch job, Accept, Cancel, Vendor confirm ผ่าน webhook) จุดที่ป้องกัน race condition ไว้จริงในโค้ด:

1. **Redis atomic queue ops** (`src/queues/worker-queue.ts`) — คิว FIFO ของ Worker ที่ ready ใช้ Redis sorted set สถานะ Worker (hash) กับการเพิ่ม/ลบในคิว (zset) เปลี่ยนพร้อมกันใน Lua script เดียว (`setWorkerQueueState`) ส่วน `popReadyWorkers` ใช้ Lua ที่ `ZPOPMIN` พร้อมเปลี่ยนเป็น `assigned` ในคำสั่งเดียว และทิ้งสมาชิกที่สถานะไม่ใช่ `ready` (สถานะค้าง) ไม่จ่ายงานให้คนที่ offline ไปแล้ว ตอนกด online ระบบเช็คว่าอยู่ในคิวจริง (`ZSCORE`) ไม่ใช่แค่ดูสถานะ จึงกู้สถานะ "ready แต่ไม่อยู่ในคิว" ได้เอง Connection ที่ request ใช้ตั้งให้ล้มเร็ว (`REDIS_FAIL_FAST_OPTIONS` retry 2 ครั้ง timeout 5 วินาที) Redis ล่มแล้ว request ได้ error แทนที่จะค้าง ส่วน BullMQ worker ยังรอต่อใหม่ได้ไม่จำกัด
2. **Postgres row lock (`SELECT ... FOR UPDATE`) ลำดับเดียวทั้งระบบ** — ทุก transaction ที่แก้ข้อมูลของรถคันหนึ่งต้อง lock แถว `ticket_jobs` ของรถคันนั้นก่อนเสมอ (`ticketJobRepository.lockTicketJob`) แล้วค่อย lock ตามลำดับ `ticket_jobs` → `market_jobs` → `booth_jobs` → `ticket_job_assignments` → `master_workers` แถว `ticket_jobs` จึงเป็น mutex ประจำรถ flow ที่ชนกันบนรถคันเดียวกัน (Gate แก้ตั๋ว, Vendor ยืนยัน, Admin ถอดคน/ยกเลิก, ส่งยอด, dispatch, scan, scan timeout) ต่อคิวกันที่ด่านแรกและไม่เกิด deadlock
3. **Transaction (`withTransaction`)** — ทุก workflow ที่เขียนหลาย table ในจังหวะเดียว (สร้าง assignment, ยกเลิกงาน, finalize การเงิน) ใช้ transaction เดียวกันเสมอ ถ้าขั้นตอนกลางทางล้มเหลว จะ rollback ทั้งหมด ไม่ทิ้งข้อมูลค้างครึ่งๆ กลางๆ ยกเว้นการปิดยอดทั้ง Business Ticket ที่อยู่ใน `SAVEPOINT` ถ้าข้อมูลไม่พร้อม (ApiError) จะ rollback เฉพาะการปิดยอด ผลยืนยันแผงยังอยู่ Admin ได้ SSE `MARKET_FINANCIALIZE_FAILED` (ครั้งเดียวต่อตลาด) และ sweep ทุก 2 นาทีลองปิดยอดและปิดงานรถซ้ำ (`retryPendingTicketJobClose`)
4. **Re-check สถานะซ้ำในทรานแซกชันเดียวกับ mutation** — เช่น `POST /api/admin/vehicle-jobs/assignment/cancel` ระดับทั้งคัน จะ lock แถวงานรถแล้วเช็คสถานะซ้ำในทรานแซกชันเดียวกับตอนยกเลิกจริง กันกรณี Vendor เพิ่ง confirm ปิดงานพร้อมกันพอดีกับที่ Admin กดยกเลิก (ดู 409 `VEHICLE_JOB_CLOSED` ใน `admin-jobs.yaml`)
5. **BullMQ deduplication ด้วย jobId คงที่** — delayed job ทุกชนิด (accept-timeout, scan-timeout, scan-warning, vendor-confirm-timeout, worker-break-return, worker-shift-end) ใช้ `jobId` ที่สร้างจาก entity id ตรงๆ (เช่น `assignment-timeout-{assignmentId}`) ก่อน schedule ใหม่ทุกครั้งจะลบของเก่าด้วย id เดียวกันทิ้งก่อนเสมอ (`removeAssignmentTimeout`, `removeScanTimeout` ฯลฯ) กันสอง schedule ซ้อนกันสำหรับ entity เดียวกัน
6. **Timeout handler เช็คสถานะก่อนทำงานเสมอ (กัน race กับ action จริงของ user)** — `handleAssignmentAcceptTimeout`/`handleAssignmentScanTimeout` เช็คสถานะปัจจุบันของ assignment ในทรานแซกชันก่อนเปลี่ยนสถานะ ถ้า Worker เพิ่งกด Accept/Scan ไปก่อนหน้าเสี้ยววินาที (แพ้ race ให้ user) timeout handler จะเห็นว่าสถานะเปลี่ยนไปแล้วและ return เฉยๆ ไม่ทำอะไรต่อ (ไม่ยิง notification ปลอม)
7. **Idempotency ฝั่ง Gate (`gate_transaction_ref`)** — `POST /api/gate/tickets` คำนวณ `gate_transaction_ref` แบบ deterministic จาก payload (`buildGateTransactionRef`) ถ้า Gate ยิง request เดิมซ้ำ (retry เพราะ network timeout เป็นต้น) ระบบเทียบ payload snapshot เดิม ถ้าตรงกันคืน response เดิมที่เคยตอบไปแล้ว (`Result: REPLAYED`) ไม่สร้างข้อมูลซ้ำ ถ้า payload ไม่ตรงกับที่เคยบันทึกไว้คืน 409 `GATE_TRANSACTION_REF_PAYLOAD_MISMATCH` และถ้ามี request เดิมกำลังประมวลผลอยู่พอดี (response snapshot ยังไม่เสร็จ) คืน 409 `GATE_REQUEST_RESPONSE_NOT_READY` แทนที่จะให้สอง request วิ่งขนานกันสร้างข้อมูลซ้ำ
8. **Worker หนึ่งคนมีงานได้ทีละงาน** — Admin เลือกคนจากคิว (assign-workers / นำคนกลับเข้าแผง) ดึงคนออกจากคิวแบบ atomic (`claimReadyWorkerForAssignment` ใช้ Lua `ZREM` พร้อมเปลี่ยนเป็น `assigned`) ภายใน transaction ก่อนสร้าง assignment ถ้า dispatch ดึงไปก่อนจะได้ 409 `WORKER_NOT_READY` และถ้า transaction ล้มจะคืนคนกลับหน้าคิว ฝั่ง dispatch จะ lock `master_workers` แล้วเช็ค DB ว่าคนที่ pop มาไม่มีงานค้าง (`findBusyWorkerIds`) ก่อนสร้าง และการคืนคิวทุกทาง (`requeueWorkersAtFrontRespectingShift`) ข้ามคนที่ยังมีงานอยู่ และ Admin force สถานะไม่ได้ถ้า Worker ยังมีงานค้างทุกสถานะ (รวม `DELIVERED` รอ Vendor ยืนยัน) ได้ 409 `WORKER_HAS_ACTIVE_ASSIGNMENT` ต้องปล่อยผ่าน `release-workers` หรือยกเลิกตาม flow ปกติ
9. **TOCTOU บน unique constraint ระดับ DB** — เช่นตอนสร้าง/แก้ Worker (`assertWorkerCodeAvailable` เช็คก่อน แล้ว catch Prisma `P2002` ซ้ำอีกชั้นตอน insert จริง) กันสอง request ผ่านการเช็คซ้ำกันได้ก่อนอีกฝ่าย commit

---

## Realtime — ระบบแจ้งเตือนแบบ Realtime

ระบบมี 3 ช่องทาง realtime แยกตามผู้รับ ไม่มีตาราง event กลาง แต่ละช่องทางเรียกจากจุดเดียวกันในโค้ด (`publishNotification`/`sendWorkerSocketEvent`/`publishRealtimeEvent` ใน `src/services/shared/realtime-notification.service.ts` เป็นจุดกลางที่ orchestrate ทั้ง Worker socket และ Admin SSE พร้อมกันในคราวเดียว)

### 1. Worker — WebSocket (`GET /ws/workers`, `src/websockets/worker.socket.ts`)

- Auth ผ่าน header `Authorization: Bearer <access_token>` หรือ `Sec-WebSocket-Protocol: token.<access_token>` เท่านั้น ไม่รับ query `?token=` (query string ติด log ของ proxy) ส่ง token ทาง query จะได้ 401 ข้อความจาก client จำกัดขนาด 4 KB
- ต่อเชื่อมสำเร็จ: บันทึก presence (`recordWorkerHeartbeat`), ส่ง `WORKER_CONNECTED` กลับ, แจ้ง Admin ผ่าน SSE ว่า socket เชื่อมต่อแล้ว (`WORKER_CONNECTION_CHANGED`)
- Heartbeat: server ping ทุก 30 วินาที ถ้า client ไม่ pong กลับรอบก่อนหน้าจะ terminate connection
- **Disconnect grace period 15 วินาที** (`WORKER_SOCKET_DISCONNECT_GRACE_MS`) — หลุดการเชื่อมต่อไม่ประกาศ `WORKER_CONNECTION_CHANGED (disconnected)` ทันที รอ 15 วิให้ reconnect ก่อน (กันเน็ตกระตุกสั้นๆ ทำให้ Admin เห็น Worker หลุด-ต่อถี่เกินจำเป็น) ยกเว้น logout/Admin revoke session จะตัดและแจ้งทันทีไม่รอ grace (`disconnectWorkerSocket`)
- Event ที่ระบบส่งให้ Worker (`WorkerSocketEventType`): `WORKER_ASSIGNED`, `ASSIGNMENT_TIMEOUT`, `ASSIGNMENT_CANCELLED`, `TEAM_READY`, `ASSIGNMENT_SCAN_DEADLINE_EXTENDED/SHORTENED`, `TICKET_COMPLETION_SUBMITTED`, `TICKET_COMPLETION_RESULT`, `STALL_JOB_CANCELLED`, `MARKET_JOB_CANCELLED`, `VEHICLE_JOB_CANCELLED`, `TICKET_JOB_UPDATED` (Gate แก้ไขตั๋ว), `TICKET_WORKER_CANCELLED`, `TICKET_WORKER_CANCELLED_FROM_BOOTH`, `WORKER_REMOVED_FROM_VEHICLE_JOB` (ถูกถอดหลัง release/รถปิด), `TEAM_WAITING_REPLACEMENT` (ทีมต้องรอคนใหม่สแกน), `BOOTH_MEMBERS_CHANGED` (ถูกนำกลับ/เลือกเข้าแผง), `WORKER_STATUS_CHANGED`, `SESSION_REVOKED` ฯลฯ
- Event กลุ่มที่อยู่ใน `PUSH_WORKER_SOCKET_EVENTS` จะส่ง FCM push (ผ่าน `sendWorkerPushNotificationByWorkerIds`) และบันทึกลง notification inbox (`persistWorkerNotification`) ควบคู่ไปกับ WebSocket เสมอ ไม่ใช่แค่ตอน offline — เพื่อให้ Worker เห็นใน `GET /api/workers/me/notifications` ย้อนหลังได้ด้วย
- ทุก event แนบ `server_time`/`server_time_unix_ms` เหมือนกับ REST response เพื่อให้ frontend คำนวณ offset เวลาได้วิธีเดียวกันทั้งระบบ

### 2. Admin — Server-Sent Events (`GET /api/admin/events`, `src/services/notifications.service.ts`)

- ต้อง role `admin` + permission `jobs:read` เปิด connection ค้างไว้รับ `text/event-stream`
- เปิด connection สำเร็จได้ event `connected` ก่อน 1 ครั้งเสมอ ตามด้วย heartbeat comment (`: heartbeat ...`) ทุก 25 วินาที (ไม่ใช่ event ให้ parse)
- Event ถูกกรองด้วย `audience` (roles/account_ids) — ส่วนใหญ่ใช้ `{ roles: ["admin"] }` กระจายให้ Admin ทุกคนที่ต่อ SSE อยู่ ณ ขณะนั้น
- Event ชนิดพิเศษ `worker_force_status_changed` และ event กลุ่ม security/audit (27.12 ใน `admin-audit.yaml`) มีสิทธิ์เห็นเพิ่มตาม permission เฉพาะ

### 3. Vendor — LINE Flex Message (`POST /api/line/webhook`, `src/services/line.service.ts` + `src/utils/line-flex-message.ts`)

- ไม่ใช่ persistent connection แบบสองช่องทางบน แต่เป็น push message ทีเดียวจบต่อเหตุการณ์ (LINE Messaging API)
- ส่ง Flex Message พร้อมปุ่ม confirm/reject ที่ผูก postback token เฉพาะ (`buildVendorCompletionPostbackData`) — กดปุ่มจะยิงกลับมาที่ `POST /api/line/webhook` เป็น postback event
- มีหน้าเว็บสำรอง `GET /api/line/dev` (+ `/api/line/dev/submissions`, ไม่ต้องยืนยันตัวตน ใช้ได้ใน production ด้วย) ไว้กดยืนยัน/ปฏิเสธแทนเมื่อ LINE Messaging API ติด rate limit — ผ่าน flow เดียวกับ LINE จริงทุกอย่าง (`applyVendorTicketCompletionResult`) ต่างแค่ไม่ส่งข้อความผ่าน LINE Messaging API

