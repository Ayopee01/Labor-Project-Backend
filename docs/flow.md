Flow การทำงานระบบ Labor

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
  "Dispatch": true
}
```

- `Dispatch`: กำหนด status ลงสินค้าเพื่อเรียก Worker เข้าคิว — `true` จะเป็นการเรียก Worker ทันที, `false` จะยังไม่เรียก Worker จะรอ Driver เป็นคนเปลี่ยน status เอง

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

1. หา VehicleJob ทั้งหมดที่ยัง dispatchable (สถานะ WORKING/WAIT ที่ dispatch=true และ workers_required ยังไม่ครบ)
2. ต่อคันรถ: **lock แถวในคันด้วย `SELECT ... FOR UPDATE`** ก่อนนับ active assignment กันสอง process จ่าย Worker ให้คันเดียวกันซ้ำพร้อมกัน
3. คำนวณ `workersNeeded = workers_required - activeAssignments`
4. ดึง Worker จาก Redis FIFO queue ด้วย `ZPOPMIN` (atomic — ดูหัวข้อ Concurrency) ตามจำนวนที่ขาด
5. ต่อ Worker แต่ละคนที่ pop มา: ตรวจตารางกะปัจจุบันอีกครั้ง (กันกรณี dispatch ช้าจนกะหมดพอดี) ถ้าอยู่ในกะจริงถึงสร้าง `VehicleJobAssignment` (สถานะ `PENDING`) พร้อม `accept_deadline_at` (`worker_accept_deadline_seconds` จาก runtime settings) แล้วตั้ง BullMQ delayed job สำหรับ accept-timeout
6. ส่ง WebSocket event `WORKER_ASSIGNED` ให้ Worker คนนั้น (พร้อม FCM push) และ SSE `WORKER_ASSIGNED` ให้ Admin

---

## Step 3: Worker กด Accept งาน

`POST /api/workers/me/assignments/{ticketNumber}/accept`

- ต้องกดภายใน `accept_deadline_at` ไม่งั้นระบบ (BullMQ job) จะเรียก `handleAssignmentAcceptTimeout` ให้เอง: นับ `accept timeout streak`, ถ้ายังไม่ถึง limit (`worker_accept_timeout_limit`) จะ requeue กลับเข้าคิว, ถ้าถึง limit จะปิดกะให้ (`closeWorkerShift`) แล้วส่งกลับ `open_app`
- กด Accept สำเร็จ: บันทึกเวลา `accepted_at`, ตั้ง `scan_deadline_at` ใหม่ (สำหรับขั้นตอน check-in), ตั้ง BullMQ job คู่ scan-timeout + scan-warning (แจ้งเตือน Admin ก่อนหมดเวลาจริงตาม `worker_scan_warning_before_minutes`)

---

## Step 4: Worker สแกน QR Check-in เข้างาน

`POST /api/workers/me/assignments/check-in-barcode` — สแกนบาร์โค้ด `ticket_no` ที่พิมพ์บนตั๋วกระดาษของด่าน (ไม่ใช่ QR ของ `Qr.DriverQrToken` ใน Step 1 ซึ่งใช้เฉพาะฝั่ง Driver)

- ถ้าไม่สแกนก่อน `scan_deadline_at` หมด → BullMQ scan-timeout job จะ mark assignment เป็น `TIMEOUT`, ปลด Worker กลับ `open_app`, แจ้งเตือนผ่าน WebSocket/SSE
- สแกนทันเวลา → assignment เปลี่ยนเป็น `SCANNED`/`ACCEPTED` (ตามทีมพร้อมหรือยัง) ระบบเช็ค `getVehicleJobTeamScanReadiness` ทุกครั้ง

---

## Step 5: ทีมพร้อมครบ (TEAM_READY) และเริ่มทำงาน

เมื่อ Worker ทุกคนที่ assign ให้คันนี้สแกนเข้างานครบ ระบบเรียก `markVehicleJobInProgress` เปลี่ยน VehicleJob เป็น `WORKING` และส่ง WebSocket event `TEAM_READY` ให้ทุกคนในทีม (พร้อม FCM push) — ตั้งแต่จุดนี้ Worker ถือว่าเริ่มทำงานจริง

---

## Step 6: Worker ส่งยอดสินค้า (Ticket Completion Submit)

`POST /api/workers/me/assignments/tickets/complete` (หรือ Admin ส่งแทนที่ `POST /api/admin/vehicle-jobs/{ticketNumber}/tickets/{ticketNo}/stalls/{stallCode}/override-count`)

- ตรวจว่าสินค้าที่ส่งมาครบทุกชิ้นของ Booth นั้น (`validateTicketCompletionItems`) ProductCode ห้ามสลับ แต่เปลี่ยน PackageCode ได้ (ต้องคำนวณ Rate Snapshot ใหม่เสมอ ห้ามใช้ Rate เดิม)
- Booth เปลี่ยนเป็น `DELIVERED` รอ Vendor ยืนยัน — ระบบส่ง LINE Flex Message ไปหา Vendor พร้อม postback token คู่ confirm/reject (`buildVendorCompletionPostbackData`) และตั้ง BullMQ job `vendor-confirm-timeout` (auto-confirm ถ้า Vendor เงียบเกิน `vendor_confirm_timeout_hours`, หรือ `vendor_reconfirm_timeout_hours` ถ้าเป็นรอบส่งใหม่หลัง reject)
- ถ้า Worker คนที่ส่งหมดกะไปแล้วตอนนี้พอดี ระบบจะย้ายกลับ `open_app` ให้ทันที และถ้าทุก Booth ของคันนี้ถูกจัดการครบ (ส่งยอด/ยืนยัน/ยกเลิก) พร้อมกับ Worker ทั้งทีมหมดกะไปแล้วทุกคน (ไม่ใช่แค่บางคน) ระบบจะปล่อยทั้งทีมกลับคิวให้อัตโนมัติ (`autoReleaseVehicleJobWorkersIfShiftEnded`) โดยไม่ต้องรอ Admin กด release-workers

---

## Step 7: Vendor ยืนยัน/ปฏิเสธผ่าน LINE (หรือ Auto-confirm / Admin แทน)

`POST /api/line/webhook` (LINE postback) — เทียบ signature ก่อน (HMAC SHA-256 ด้วย `LINE_CHANNEL_SECRET`) แล้ว verify action token (`vendor_confirm_completion` / `vendor_reject_completion`) ผ่าน `applyVendorTicketCompletionResult` (`src/services/shared/ticket-completion.service.ts`) — ใช้ path เดียวกันไม่ว่าจะยืนยันจาก LINE จริง, `/api/line/dev/submissions/{id}/confirm|reject` (เครื่องมือ dev สำรองเมื่อ LINE Messaging API ติด rate limit), หรือ auto-confirm ตอน timeout

- **Confirm**: ยกเลิก BullMQ vendor-confirm-timeout job ที่ค้างไว้ (กันยิงซ้ำ), เช็คว่า Booth ทุกใบของ VehicleJob จัดการครบหรือยัง — ถ้าครบเรียก `closeCompletedVehicleJobIfReady` (finalize การเงิน + ปิดงาน) ถ้ายังไม่ครบเรียก `activateNextTicketIfReady` (เปิด Booth/Ticket ถัดไปให้ทำต่อ)
- **Reject**: Booth กลับไปสถานะ `REJECT`, assignment เปลี่ยนเป็น `REJECT`, Worker/Admin ส่งยอดใหม่ได้อีกครั้ง (timeout รอบใหม่ใช้ `vendor_reconfirm_timeout_hours` ที่สั้นกว่ารอบแรก)
- Worker และ Admin ได้รับ event `TICKET_COMPLETION_RESULT` ทั้งคู่ (WebSocket/SSE) ไม่ว่าผลจะมาจาก LINE จริงหรือ auto-confirm timeout

---

## Step 8: ปิดงาน (Financialize) และ Worker กลับเข้าคิว

เมื่อ Booth สุดท้ายของ VehicleJob confirm ครบ:

1. `closeCompletedVehicleJobIfReady` finalize การเงินของทุก Booth/Product/Worker (ผูก Rate Snapshot ที่บันทึกไว้ตอน submit ไม่คำนวณใหม่จาก Master Rate ปัจจุบัน) แล้วเปลี่ยน VehicleJob เป็น `COMPLETED`
2. `returnCompletedWorkersToQueue` พา Worker แต่ละคนกลับเข้าคิว FIFO ถ้ายังอยู่ในกะ (หรือ `open_app` ถ้าหมดกะแล้ว) แล้วเรียก `dispatchReadyWorkers()` ซ้ำทันทีให้คันอื่นที่รออยู่ได้ Worker ต่อ
3. Admin ที่ต้องการปล่อย Worker กลับคิวก่อนที่ Vendor จะยืนยันครบ (เช่น รอ Vendor เซ็นรับของอยู่) ใช้ `POST /api/admin/vehicle-jobs/{ticketNumber}/release-workers` ได้ — VehicleJob จะเป็น `RELEASED` (ไม่ใช่ `COMPLETED`) Worker ออกจากงานได้แต่ Booth ยังไม่ปิดจนกว่า Vendor จะยืนยันจริง

---

## Concurrency — การจัดการ concurrency ในระบบ

ระบบมี Worker/Admin หลายคนยิง request พร้อมกันตลอดเวลา (Dispatch job, Accept, Cancel, Vendor confirm ผ่าน webhook) จุดที่ป้องกัน race condition ไว้จริงในโค้ด:

1. **Redis atomic queue ops** (`src/queues/worker-queue.ts`) — คิว FIFO ของ Worker ที่ ready ใช้ Redis sorted set (`ZADD`/`ZPOPMIN`) ไม่ใช่ array ธรรมดา เพราะ `ZPOPMIN` เป็นคำสั่ง atomic ระดับ Redis เอง ป้องกันสอง dispatch process ดึง Worker คนเดียวกันออกจากคิวซ้ำ (`popReadyWorkers`) เขียน status hash (`READY`) ให้เสร็จก่อน `ZADD` เสมอทุกจุดที่ enqueue เพื่อลด window ที่ Worker ถูก pop ออกจากคิวไปแล้วแต่ status ยังไม่ทันอัปเดต
2. **Postgres row lock (`SELECT ... FOR UPDATE`)** — ตอน dispatch ให้ VehicleJob คันหนึ่ง (`dispatchReadyWorkersForVehicleJob`) จะ lock แถว `vehicle_jobs` ก่อนนับ active assignment เสมอ กันสอง request (เช่น Driver กด ready พร้อมกับ Admin เปิด dispatch เอง) คำนวณจำนวน Worker ที่ต้องการซ้ำกันจนจ่ายเกิน
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
- Event ที่ระบบส่งให้ Worker (`WorkerSocketEventType`): `WORKER_ASSIGNED`, `ASSIGNMENT_TIMEOUT`, `ASSIGNMENT_CANCELLED`, `TEAM_READY`, `ASSIGNMENT_SCAN_DEADLINE_EXTENDED/SHORTENED`, `TICKET_COMPLETION_SUBMITTED`, `TICKET_COMPLETION_RESULT`, `STALL_JOB_CANCELLED`, `MARKET_JOB_CANCELLED`, `VEHICLE_JOB_CANCELLED`, `WORKER_STATUS_CHANGED`, `SESSION_REVOKED` ฯลฯ
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

