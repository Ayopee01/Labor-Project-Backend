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
   - `POST /api/workers/me/break` พักได้เฉพาะตอนยังไม่ถูก assign งาน ตามจำนวนครั้ง (`worker_break_limit`) และเวลา (`worker_break_duration_minutes`) ที่ตั้งไว้ ครบเวลาแล้ว job `worker-break-return` พากลับเข้าคิว ถ้าตอนนั้น socket หลุด ระบบรอให้ต่อกลับภายใน `worker_break_retry` นาที (แจ้ง `WORKER_BREAK_RETURN_ACTION_REQUIRED`) เกินเวลาจะค้างเป็น `open_app` เหตุผล `break_retry_expired` ให้ Admin จัดการ
     - ระหว่างรอ (`open_app` เหตุผล `break_ended_awaiting_reconnect`) จะพากลับเข้าคิวอัตโนมัติตอนต่อ socket ได้ก็ต่อเมื่อเหตุผลยังเป็นค่านี้ อยู่ในกะเดิม กะยังไม่ถูกปิด และไม่มีงานค้าง ถ้า Admin force เป็น `open_app` (เหตุผลเปลี่ยนเป็น `admin_forced_status`) หรือกะถูกปิดไปก่อน จะไม่พากลับเข้าคิวและไม่แจ้ง `WORKER_BREAK_RETRY_EXPIRED` ต้องให้ Admin force กลับเข้าคิวเอง
     - ถ้า Admin revoke session ระหว่างรอ ระบบจะไม่ปิดกะให้ (เหตุผลยังเป็น `break_ended_awaiting_reconnect`) Worker ที่ login แล้วต่อ socket กลับมาทันเวลาจะกลับเข้าคิวได้ตามปกติ
   - `POST /api/workers/me/offline` ออกจากคิว และกลับเข้าคิวไม่ได้อีกจนกะถัดไป
   - `GET /api/workers/me/status` ใช้ restore หน้าจอหลังเปิดแอปใหม่ (profile, กะ, สถานะคิว, งานปัจจุบัน, เหตุผลที่ปิดกะ)
6. **หมดกะ**: job `worker-shift-end` ปิด attendance และย้าย Worker ที่ว่างเป็น `open_app` ถ้ายังมีงานค้างจะให้ทำงานต่อจนจบ แล้วค่อยออกตอนส่งยอด/ปิดงาน
7. **สาเหตุที่ Worker ถูกย้ายเป็น `open_app`** (`open_app_reason`): `scan_timeout`, `admin_cancel_assignment`, `admin_forced_status`, `break_ended_awaiting_reconnect`, `break_retry_expired` รวมถึงหมดกะ และกดรับงานไม่ทันครบ `worker_accept_timeout_limit` ครั้ง (ปิดกะ)

---

## Step 1: Driver เข้ามา Gate

Gate จะทำการออก Ticket ให้โดยจะเก็บข้อมูลตาม API

`POST {{baseUrl}}/api/gate/tickets`

Body

```json
{
  "TicketNumber": "เลข Ticket ใหญ่ ระดับรถ",
  "TicketNo": "เลข Ticket ระดับ Market",
  "TicketCreatedAt": "เวลาที่ Ticket หลังถูกบันทึกลง DB",
  "BoothCount": "จำนวน Booth ใน Market",
  "MarketCode": "Code ของ Market อิงจาก DB",
  "DropoffPoint": "จุดลงสินค้า Gate จะส่งมา",
  "LicensePlate": "เลขทะเบียน Gate จะส่งมา",
  "LicensePlateProvince": "จังหวัดทะเบียน Gate จะส่งมา",
  "VehicleTypeCode": "Code ประเภทรถ",
  "VehicleTypeName": "Name ประเภทรถ",
  "Booths": [
    {
      "BoothCode": "Code ของแผง",
      "Products": [
        {
          "ProductCode": "Code ของสินค้า",
          "PackageCode": "Code ของแพ็คเกจสินค้า",
          "Quantity": "จำนวน"
        }
      ]
    }
  ],
  "Dispatch": true,
  "IdempotencyKey": "(ไม่บังคับ) key สำหรับ retry ถ้าไม่ส่งระบบจะ hash ทั้ง body แทน"
}
```

- `Dispatch`: กำหนด status ลงสินค้าเพื่อเรียก Worker เข้าคิว — `true` งานรถเป็น `WORKING` และเรียก Worker ทันที, `false` งานรถเป็น `WAIT` รอ Driver เป็นคนเปลี่ยน status เอง
- รถหนึ่งคัน (`TicketNumber`) มีได้หลาย Business Ticket (`TicketNo` ละ 1 ตลาด) ส่ง `TicketNo` เดิมในตลาดเดิมซ้ำ = เพิ่มแผงเข้าใบเดิม
- ระบบ snapshot Rate จาก Master ไว้ตั้งแต่ตอนนี้ (ใช้คำนวณเงินตอน Financialize)

Response

```
{
  "Result": "CREATED | REPLAYED",           // ส่ง gate_transaction_ref ซ้ำ (idempotent) จะได้ REPLAYED
  "TicketNumber": "เลข Ticket ใหญ่ ระดับรถ (ส่งกลับตามที่ส่งมา)",
  "Ticket": {
    "TicketNo": "...",
    "TicketCreatedAt": "เวลาที่บันทึกลง DB จริง",
    "BoothCount": 2,
    "LicensePlate": "...",
    "LicensePlateProvince": "...",
    "VehicleTypeCode": "...",
    "VehicleTypeName": "...",
    "Status": "unload_now | waiting_unload"
  },
  "Market": { "MarketCode": "...", "MarketName": "...", "DropoffPoint": "..." },
  "Booths": [ /* GateTicketResponseBooth[] */ ],
  "WorkerCount": 5,                          // MAX ของทุกสินค้าทุกแผงใน Ticket นี้ (ไม่ใช่ผลรวม) — ใช้คำนวณจำนวน Worker ที่ต้อง dispatch
  "Qr": { "DriverQrToken": "..." }            // ใช้ร่วมกันทั้งคัน — Driver ใช้สแกนเข้า /api/driver/qr-sessions
}
```

ระบบยังไม่คำนวณยอดเงินตรงนี้ (ทำตอน Financialize หลังงานเสร็จ) — ดูรายละเอียด schema เต็มที่ `GateTicketResponse` ใน `src/docs/openapi/components.yaml`

หมายเหตุ: `Dispatch: true` จะเรียก `dispatchReadyWorkers()` ทันทีหลังสร้าง Ticket เสร็จ (ดู Step 2) ส่วน `Dispatch: false` งานรถจะอยู่สถานะ `WAIT` รอ Driver มากด "พร้อม" เองที่ `POST /api/driver/jobs/{ticketNumber}/ready`

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
- `POST /api/admin/vehicle-jobs/{ticketNumber}/assign-workers` เลือก Worker ที่ `ready` ในคิวให้รับงานเอง (ไม่เกิน `WorkersRequired`) บันทึก `MANUAL_ASSIGNMENT` ลง admin_action_logs จากนั้น Worker กดรับและสแกนตาม flow ปกติ

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
- จำนวนที่ต้องสแกนครบ = `workers_required` ลบจำนวนคนที่ Admin ถอดออกหลังสแกนแล้ว (`removed_after_scan_count`)

---

## Step 5: ทีมพร้อมครบ (TEAM_READY) และเริ่มทำงาน

เมื่อทีมสแกนเข้างานครบ ระบบเรียก `markTicketJobInProgress` บันทึก `work_started_at` (ครั้งแรกเท่านั้น) และเปิดแผงถัดไปให้ทำ (`activateNextTicketIfReady` — Business Ticket/แผงเป็น `WORKING`) แล้วส่ง WebSocket event `TEAM_READY` ให้ทุกคนในทีม (พร้อม FCM push) — ตั้งแต่จุดนี้ Worker ถือว่าเริ่มทำงานจริง

---

## Step 6: Worker ส่งยอดสินค้า (Ticket Completion Submit)

`POST /api/workers/me/assignments/tickets/complete` (หรือ Admin ส่งแทนที่ `POST /api/admin/vehicle-jobs/{ticketNumber}/tickets/{ticketNo}/stalls/{stallCode}/override-count`)

- ตรวจว่าสินค้าที่ส่งมาครบทุกชิ้นของ Booth นั้น (`validateTicketCompletionItems`) ProductCode ห้ามสลับ แต่เปลี่ยน PackageCode ได้ (ต้องคำนวณ Rate Snapshot ใหม่เสมอ ห้ามใช้ Rate เดิม) — Worker ดู PackageCode ที่เลือกได้จาก `GET /api/workers/me/products/{productCode}/packages`
- ทีมต้องสแกนครบก่อนส่งยอด (`WORKERS_NOT_CHECKED_IN`) และแผงต้องมี LINE ของ Vendor ผูกไว้ (`TICKET_VENDOR_LINE_NOT_CONFIGURED`)
- ระบบ snapshot รายชื่อ Worker ของรอบส่งยอดนี้ (Worker ส่งเอง = คนที่ `WORKING` ตอนส่ง) — รายชื่อนี้คือกลุ่มที่ได้ค่าแรงของแผงถ้า Vendor ยืนยัน
- Admin ส่งแทนได้เฉพาะแผงที่เคยมี Worker ส่งยอดมาแล้ว (ปกติคือแผงที่ถูกตีกลับ) และทีมต้องสแกนครบ (รวมทีมที่ release แล้ว) ค่าแรงของรอบนี้หารให้กลุ่มของรอบล่าสุดที่ Worker ส่ง ไม่เช่นนั้นคืน 409 `ADMIN_SUBMIT_REQUIRES_WORKER_SUBMISSION` / `WORKERS_NOT_CHECKED_IN`
- Booth เปลี่ยนเป็น `DELIVERED` รอ Vendor ยืนยัน — ระบบส่ง LINE Flex Message ไปหา Vendor ทุกคนที่ผูกกับแผง (เจ้าของแผงและลูกน้องแผง) พร้อม postback token คู่ confirm/reject (`buildVendorCompletionPostbackData`) และตั้ง BullMQ job `vendor-confirm-timeout` (auto-confirm ถ้า Vendor เงียบเกิน `vendor_confirm_timeout_minutes`, หรือ `vendor_reconfirm_timeout_minutes` ถ้าเป็นรอบส่งใหม่หลัง reject) — deadline = `max(เวลาส่งยอด, updated_at ของ setting) + timeout` ถ้า Admin แก้ค่า timeout ทุกแผงที่รออยู่จะเริ่มนับใหม่จากเวลาแก้ (ตั้ง job ใหม่ทันที และ sweep ทุก 2 นาทีตัดแผงที่เลย deadline ตาม config ปัจจุบันเป็นตัวสำรอง)
- ถ้า Worker คนที่ส่งหมดกะไปแล้วตอนนี้พอดี ระบบจะย้ายกลับ `open_app` ให้ทันที และถ้าทุก Booth ของคันนี้ถูกจัดการครบ (ส่งยอด/ยืนยัน/ยกเลิก) พร้อมกับ Worker ทั้งทีมหมดกะไปแล้วทุกคน (ไม่ใช่แค่บางคน) ระบบจะปล่อยทั้งทีมกลับคิวให้อัตโนมัติ (`autoReleaseTicketJobWorkersIfShiftEnded`) โดยไม่ต้องรอ Admin กด release-workers

---

## Step 7: Vendor ยืนยัน/ปฏิเสธผ่าน LINE (หรือ Auto-confirm / Admin แทน)

`POST /api/line/webhook` (LINE postback) — เทียบ signature ก่อน (HMAC SHA-256 ด้วย `LINE_CHANNEL_SECRET`) แล้ว verify action token (`vendor_confirm_completion` / `vendor_reject_completion`) ผ่าน `applyVendorTicketCompletionResult` (`src/services/shared/ticket-completion.service.ts`) — ใช้ path เดียวกันไม่ว่าจะยืนยันจาก LINE จริง, `/api/line/dev/submissions/{id}/confirm|reject` (เครื่องมือ dev สำรองเมื่อ LINE Messaging API ติด rate limit), หรือ auto-confirm ตอน timeout

- **Confirm**: ลบ BullMQ vendor-confirm-timeout job ที่ค้างไว้ (กันยิงซ้ำ), Booth เป็น `COMPLETED` และบันทึก snapshot ตัวหารค่าแรงของแผงจากรายชื่อของรอบส่งยอดที่ถูกยืนยัน (ไม่รวมคนที่ถูกถอดออกจากแผงนั้น; Worker ที่ถูกถอดออกจากงานหลังส่งยอดยังได้เงิน) จากนั้นเรียก `closeCompletedTicketJobIfReady` (ดู Step 8) ถ้างานรถยังไม่จบเรียก `activateNextTicketIfReady` เปิดแผงถัดไป และ assignment กลับเป็น `WORKING`
- **Reject**: Booth และ assignment เป็น `REJECT` Worker/Admin ส่งยอดใหม่ได้อีกครั้ง รอบใหม่ snapshot รายชื่อใหม่ (timeout รอบใหม่ใช้ `vendor_reconfirm_timeout_minutes` ที่สั้นกว่ารอบแรก)
- Worker (เฉพาะคนที่ยังอยู่ในทีม) และ Admin ได้รับ event `TICKET_COMPLETION_RESULT` (WebSocket/SSE) ไม่ว่าผลจะมาจาก LINE จริงหรือ auto-confirm timeout
- Postback ที่มาหลังรายการถูกจัดการไปแล้ว (เช่น auto-confirm ชนะไปก่อน) ระบบตอบ Vendor ว่า "รายการนี้ถูกจัดการแล้ว" และประมวลผล event อื่นต่อ
- **ให้คะแนน**: หลัง Vendor ยืนยันผ่าน LINE ระบบส่งข้อความยืนยันสำเร็จและ Flex Message ให้คะแนน (`vendor_rate_ticket`) ให้คนที่กดยืนยัน ถ้าเป็น auto-confirm ตอน timeout ระบบส่งข้อความ "ระบบยืนยันข้อมูลอัตโนมัติ" และปุ่มให้คะแนน (token แยกรายคน) ให้ทุก LINE ของแผง (เจ้าของและสมาชิก)
- แผงเก็บคะแนนได้ 1 ครั้ง (`ticket_ratings` unique ต่อแผง) คะแนนของแผง = ของคนแรกที่กด คนแรกได้ข้อความขอบคุณพร้อมสรุปค่าใช้บริการ และทุกคนในแผงได้สรุปค่าใช้บริการ (`send_vendor_ticket_payment_summary`) คนที่กดทีหลังคะแนนไม่ถูกบันทึกและระบบไม่ตอบกลับ (ได้สรุปไปแล้วตอนคนแรกให้คะแนน) ยอดคือ `booth_jobs.final_stall_amount` ที่คิดไว้ตอนยืนยัน จึงไม่ต้องรอปิดยอดทั้งใบ

---

## Step 8: ปิดงาน (Financialize) และ Worker กลับเข้าคิว

`closeCompletedTicketJobIfReady` (`src/services/shared/ticket-job-lifecycle.service.ts`) ถูกเรียกทุกครั้งที่แผงจบ (confirm หรือยกเลิก):

1. **ปิดยอดราย Business Ticket**: ใบไหนทุกแผงจบแล้ว (`COMPLETED`/`CANCELLED`) และมีแผง `COMPLETED` → `finalizeMarketJobFinancials` lock roster และคำนวณเงินของทุก Product/Worker ตาม snapshot ตัวหารของแต่ละแผง ใช้ Rate Snapshot ที่บันทึกไว้ (ไม่คำนวณใหม่จาก Master Rate ปัจจุบัน) ถ้าทุกแผงถูกยกเลิกหมด ใบนั้นเป็น `CANCELLED`
2. **ปิดงานรถ**: เมื่อทุก Business Ticket จบและปิดรับ Ticket เพิ่มแล้ว (`tickets_closed_at`) งานรถเป็น `COMPLETED` (หรือ `CANCELLED` ถ้าทุกใบถูกยกเลิก) revoke Driver session, assignment ที่สแกนแล้วเป็น `COMPLETED` ส่วนที่ยังไม่สแกนเป็น `CANCELLED`
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

`จำนวน Worker` = จำนวนคนใน snapshot ตัวหารของแผงนั้น (ดู Step 7) ถ้าแผงไม่มี snapshot ใช้ roster ที่ยัง `WORKING`

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

- **ถอด Worker ออกจากทั้งคัน**: ทำได้ทุกเวลา แม้ Worker ส่งยอดแล้วหรือเป็นคนสุดท้ายบนรถ ระบบไม่ยกเลิกแผงหรืองานรถอัตโนมัติ
  - ถ้ายังไม่สแกน: ระบบหาคนแทนจากคิวทันที
  - ถ้าสแกนแล้ว: ไม่หาคนแทน ทีมที่เหลือทำงานต่อได้ (`removed_after_scan_count` +1)
  - แผงที่ส่งยอดไปแล้ว: ถ้า Vendor ยืนยัน คนที่ถูกถอดยังได้ค่าแรงตาม snapshot ของรอบนั้น
  - Worker ที่ถูกถอดไม่ได้รับแจ้งเตือนของงานนี้อีก (ต่างจาก Worker ที่ถูก release ซึ่งยังได้รับผลการยืนยัน)
- **ถอด Worker ออกจาก Business Ticket** (`+ TicketNo + WorkerCode`): Worker ยังเช็คอินบนรถ แต่ไม่อยู่ใน roster ของใบนั้น ทำไม่ได้ถ้าใบนั้นมีแผงรอผล Vendor (`MARKET_JOB_ALREADY_SUBMITTED`) ถ้าใบนั้นเป็นงานสุดท้ายของ Worker บนรถ ระบบยกเลิก assignment ด้วย
- **ถอด Worker ออกจากแผงเดียว** (`+ TicketNo + BoothCode + WorkerCode`): ไม่นับ Worker คนนั้นเป็นตัวหารค่าแรงของแผงนั้น (roster ไม่เปลี่ยน) ทำได้เฉพาะแผงที่ยังไม่เคยส่งยอด ถ้าถอดแล้วแผงนั้นไม่เหลือ Worker ระบบยกเลิกแผงให้อัตโนมัติ และถ้าไม่เหลืองานบนรถ ระบบยกเลิก assignment ด้วย
- **เพิ่ม Worker**: `POST /api/admin/vehicle-jobs/{ticketNumber}/assign-workers` ได้ไม่เกิน `WorkersRequired` Worker ต้องกดรับและสแกนตาม flow ปกติ
- ยกเลิกทั้งคัน / ทั้ง Business Ticket / แผง ไม่ได้ถ้ามีแผงที่ส่งยอดแล้วรอผล Vendor (`DELIVERED`/`REJECT`) การยกเลิกไม่เขียนทับแผงหรือใบที่จบไปแล้ว และคำนวณสถานะของใบ/งานรถใหม่ผ่าน `closeCompletedTicketJobIfReady` เสมอ
- การยกเลิกทุกขอบเขตต้องส่ง `ReasonCode` (และ `ReasonText` ถ้ามี) บันทึกลง `admin_action_logs`

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
- สิทธิ์ของ Admin ตรวจด้วย permission ต่อ endpoint (เช่น `jobs:read`, `jobs:cancel`) ตั้งค่าที่ Admin Settings

---

## Concurrency — การจัดการ concurrency ในระบบ

ระบบมี Worker/Admin หลายคนยิง request พร้อมกันตลอดเวลา (Dispatch job, Accept, Cancel, Vendor confirm ผ่าน webhook) จุดที่ป้องกัน race condition ไว้จริงในโค้ด:

1. **Redis atomic queue ops** (`src/queues/worker-queue.ts`) — คิว FIFO ของ Worker ที่ ready ใช้ Redis sorted set (`ZADD`/`ZPOPMIN`) ไม่ใช่ array ธรรมดา เพราะ `ZPOPMIN` เป็นคำสั่ง atomic ระดับ Redis เอง ป้องกันสอง dispatch process ดึง Worker คนเดียวกันออกจากคิวซ้ำ (`popReadyWorkers`) เขียน status hash (`READY`) ให้เสร็จก่อน `ZADD` เสมอทุกจุดที่ enqueue เพื่อลด window ที่ Worker ถูก pop ออกจากคิวไปแล้วแต่ status ยังไม่ทันอัปเดต
2. **Postgres row lock (`SELECT ... FOR UPDATE`)** — ตอน dispatch ให้งานรถคันหนึ่ง (`dispatchReadyWorkersForTicketJob`) จะ lock แถว `ticket_jobs` ก่อนนับ active assignment เสมอ กันสอง request (เช่น Driver กด ready พร้อมกับ Admin เปิด dispatch เอง) คำนวณจำนวน Worker ที่ต้องการซ้ำกันจนจ่ายเกิน
3. **Transaction (`withTransaction`)** — ทุก workflow ที่เขียนหลาย table ในจังหวะเดียว (สร้าง assignment, ยกเลิกงาน, finalize การเงิน) ใช้ transaction เดียวกันเสมอ ถ้าขั้นตอนกลางทางล้มเหลว จะ rollback ทั้งหมด ไม่ทิ้งข้อมูลค้างครึ่งๆ กลางๆ
4. **Re-check สถานะซ้ำในทรานแซกชันเดียวกับ mutation** — เช่น `POST /api/admin/vehicle-jobs/assignment/cancel` ระดับทั้งคัน จะ lock แถวงานรถแล้วเช็คสถานะซ้ำในทรานแซกชันเดียวกับตอนยกเลิกจริง กันกรณี Vendor เพิ่ง confirm ปิดงานพร้อมกันพอดีกับที่ Admin กดยกเลิก (ดู 409 `VEHICLE_JOB_CLOSED` ใน `admin-jobs.yaml`)
5. **BullMQ deduplication ด้วย jobId คงที่** — delayed job ทุกชนิด (accept-timeout, scan-timeout, scan-warning, vendor-confirm-timeout, worker-break-return, worker-shift-end) ใช้ `jobId` ที่สร้างจาก entity id ตรงๆ (เช่น `assignment-timeout-{assignmentId}`) ก่อน schedule ใหม่ทุกครั้งจะลบของเก่าด้วย id เดียวกันทิ้งก่อนเสมอ (`removeAssignmentTimeout`, `removeScanTimeout` ฯลฯ) กันสอง schedule ซ้อนกันสำหรับ entity เดียวกัน
6. **Timeout handler เช็คสถานะก่อนทำงานเสมอ (กัน race กับ action จริงของ user)** — `handleAssignmentAcceptTimeout`/`handleAssignmentScanTimeout` เช็คสถานะปัจจุบันของ assignment ในทรานแซกชันก่อนเปลี่ยนสถานะ ถ้า Worker เพิ่งกด Accept/Scan ไปก่อนหน้าเสี้ยววินาที (แพ้ race ให้ user) timeout handler จะเห็นว่าสถานะเปลี่ยนไปแล้วและ return เฉยๆ ไม่ทำอะไรต่อ (ไม่ยิง notification ปลอม)
7. **Idempotency ฝั่ง Gate (`gate_transaction_ref`)** — `POST /api/gate/tickets` คำนวณ `gate_transaction_ref` แบบ deterministic จาก payload (`buildGateTransactionRef`) ถ้า Gate ยิง request เดิมซ้ำ (retry เพราะ network timeout เป็นต้น) ระบบเทียบ payload snapshot เดิม ถ้าตรงกันคืน response เดิมที่เคยตอบไปแล้ว (`Result: REPLAYED`) ไม่สร้างข้อมูลซ้ำ ถ้า payload ไม่ตรงกับที่เคยบันทึกไว้คืน 409 `GATE_TRANSACTION_REF_PAYLOAD_MISMATCH` และถ้ามี request เดิมกำลังประมวลผลอยู่พอดี (response snapshot ยังไม่เสร็จ) คืน 409 `GATE_REQUEST_RESPONSE_NOT_READY` แทนที่จะให้สอง request วิ่งขนานกันสร้างข้อมูลซ้ำ
8. **TOCTOU บน unique constraint ระดับ DB** — เช่นตอนสร้าง/แก้ Worker (`assertWorkerCodeAvailable` เช็คก่อน แล้ว catch Prisma `P2002` ซ้ำอีกชั้นตอน insert จริง) กันสอง request ผ่านการเช็คซ้ำกันได้ก่อนอีกฝ่าย commit

---

## Realtime — ระบบแจ้งเตือนแบบ Realtime

ระบบมี 3 ช่องทาง realtime แยกตามผู้รับ ไม่มีตาราง event กลาง แต่ละช่องทางเรียกจากจุดเดียวกันในโค้ด (`publishNotification`/`sendWorkerSocketEvent`/`publishRealtimeEvent` ใน `src/services/shared/realtime-notification.service.ts` เป็นจุดกลางที่ orchestrate ทั้ง Worker socket และ Admin SSE พร้อมกันในคราวเดียว)

### 1. Worker — WebSocket (`GET /ws/workers`, `src/websockets/worker.socket.ts`)

- Auth ผ่าน query `?token=`, header `Authorization: Bearer`, หรือ `Sec-WebSocket-Protocol: token.<jwt>`
- ต่อเชื่อมสำเร็จ: บันทึก presence (`recordWorkerHeartbeat`), ส่ง `WORKER_CONNECTED` กลับ, แจ้ง Admin ผ่าน SSE ว่า socket เชื่อมต่อแล้ว (`WORKER_CONNECTION_CHANGED`)
- Heartbeat: server ping ทุก 30 วินาที ถ้า client ไม่ pong กลับรอบก่อนหน้าจะ terminate connection
- **Disconnect grace period 15 วินาที** (`WORKER_SOCKET_DISCONNECT_GRACE_MS`) — หลุดการเชื่อมต่อไม่ประกาศ `WORKER_CONNECTION_CHANGED (disconnected)` ทันที รอ 15 วิให้ reconnect ก่อน (กันเน็ตกระตุกสั้นๆ ทำให้ Admin เห็น Worker หลุด-ต่อถี่เกินจำเป็น) ยกเว้น logout/Admin revoke session จะตัดและแจ้งทันทีไม่รอ grace (`disconnectWorkerSocket`)
- Event ที่ระบบส่งให้ Worker (`WorkerSocketEventType`): `WORKER_ASSIGNED`, `ASSIGNMENT_TIMEOUT`, `ASSIGNMENT_CANCELLED`, `TEAM_READY`, `ASSIGNMENT_SCAN_DEADLINE_EXTENDED/SHORTENED`, `TICKET_COMPLETION_SUBMITTED`, `TICKET_COMPLETION_RESULT`, `STALL_JOB_CANCELLED`, `MARKET_JOB_CANCELLED`, `VEHICLE_JOB_CANCELLED`, `TICKET_WORKER_CANCELLED`, `TICKET_WORKER_CANCELLED_FROM_BOOTH`, `WORKER_STATUS_CHANGED`, `SESSION_REVOKED` ฯลฯ
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

