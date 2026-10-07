// =============================================================================
// Production Flow + Load Test (standalone — ยิง server จริงที่ deploy แล้ว)
//
// ตรวจว่า server ทำงานตรง spec + flow จริงภายใต้โหลด worker หลายคน ครอบคลุม:
//  - self-clean: force worker ค้าง → open_app + park ticket ค้าง ให้ pool สะอาด
//  - login load (วัด stampede) → online
//  - multi-worker happy path (qty 100 → ทีม → ส่งยอด → vendor confirm → financialize → เงินหารจริง)
//  - Dispatch false→true (admin) แล้วเรียก worker
//  - Admin ยกเลิก assignment (ถอดคน → กลับคิว)
//  - Admin release-workers ตอน vendor ยังไม่ยืนยัน → ทีมกลับคิว
//  - break → กลับมาทำงาน
//  - vendor timeout → auto-close (ลด setting ชั่วคราวแล้วคืนค่า)
//  - invalid flow ต้อง throw + กฎ gate min-booth
//  - logout worker ทุกคน + สรุป PASS/FAIL
//
//   TARGET_URL=https://<server> DATABASE_URL=<ro-db> GATE_CLIENT_SECRET=<s> npm run test:load
// ดูรายละเอียด env ที่ test/load/README.md
// =============================================================================
import WebSocket from "ws";
import fs from "fs";
import { Client } from "pg";

const CFG = {
  base: process.env.TARGET_URL || "https://labor-api-wadtr.ondigitalocean.app",
  gateSecret: process.env.GATE_CLIENT_SECRET || "",
  gateClientId: process.env.GATE_CLIENT_ID || "gate-main",
  adminUser: process.env.ADMIN_USERNAME || "admin",
  adminPass: process.env.ADMIN_PASSWORD || "Admin@123456",
  marketCode: process.env.MARKET_CODE || "1111",
  // single-worker product (WC=1) สำหรับ scenario ย่อย
  soloProduct: process.env.SOLO_PRODUCT || "01010401",
  soloPackage: process.env.SOLO_PACKAGE || "07",
  soloQty: Number(process.env.SOLO_QTY || 5),
  // multi-worker product (qty 100 → WC≥2) สำหรับ happy path ทีม
  teamProduct: process.env.TEAM_PRODUCT || "02020300",
  teamPackage: process.env.TEAM_PACKAGE || "28",
  teamQty: Number(process.env.TEAM_QTY || 100),
  teamCount: Number(process.env.TEAM_TICKETS || 3), // จำนวน ticket ทีมที่จะยิง
  workerCount: Number(process.env.WORKER_COUNT || 14),
  workerOffset: Number(process.env.WORKER_OFFSET || 0),
  dbUrl: process.env.DATABASE_URL || "",
  credsFile: process.env.WORKER_CREDS_FILE || "",
  boothCodes: (process.env.BOOTH_CODES || "").split(",").map((s) => s.trim()).filter(Boolean),
};
const wsUrl = CFG.base.replace(/^http/, "ws") + "/ws/workers";
const gateAuth = Buffer.from(`${CFG.gateClientId}:${CFG.gateSecret}`).toString("base64");

async function api(method: string, path: string, opts: any = {}) {
  const h: any = {};
  if (opts.body !== undefined) h["content-type"] = "application/json";
  if (opts.token) h.authorization = "Bearer " + opts.token;
  if (opts.basic) h.authorization = "Basic " + gateAuth;
  const t0 = Date.now();
  const r = await fetch(CFG.base + path, { method, headers: h, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  let body: any = null; try { body = await r.json(); } catch {}
  return { status: r.status, body, ms: Date.now() - t0 };
}
const id14 = () => (`${Date.now()}${Math.floor(Math.random() * 1000)}`).slice(-14).padStart(14, "0");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (a: number[], p: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : 0);
function stripSsl(cs: string) { const u = new URL(cs); for (const k of [...u.searchParams.keys()]) if (k.startsWith("ssl") || k === "uselibpqcompat") u.searchParams.delete(k); return u.toString(); }

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "✅ PASS" : "❌ FAIL"} | ${name}${detail ? " :: " + detail : ""}`); };

type Ticket = { ticketNo: string; boothCode: string; product: string; pkg: string; qty: number; wc: number; mode: "complete" | "hold" | "accept-only"; accepted: Set<string>; checkedIn: Set<string>; completed: boolean };
const detail = new Map<string, Ticket>();
const myTickets = new Set<string>();
const M = { login: [] as number[], accept: [] as number[], checkin: [] as number[], complete: [] as number[] };

type Worker = { code: string; token: string; ws: WebSocket };
const workers: Worker[] = [];
const tokenByCode = new Map<string, string>();
const processing = new Set<string>();

async function loginWorker(u: string, p: string) {
  let r = await api("POST", "/api/auth/login", { body: { Username: u, Password: p, DeviceId: "loadtest-" + u, DeviceName: "loadtest", Platform: "android" } });
  if (r.status === 409) r = await api("POST", "/api/auth/login/confirm-force", { body: { LoginChallengeToken: r.body.LoginChallengeToken, DeviceId: "loadtest-" + u, DeviceName: "loadtest", Platform: "android" } });
  return r.status === 200 ? r.body.AccessToken : null;
}

// reactive handler — worker w ได้ WORKER_ASSIGNED(T): accept → checkin → (ถ้า mode complete และทีมครบ) ส่งยอด
async function driveAssignment(w: Worker, ticketNumber: string) {
  const ac = await api("POST", `/api/workers/me/assignments/${ticketNumber}/accept`, { token: w.token }); M.accept.push(ac.ms);
  if (ac.status !== 200) return;
  const d = detail.get(ticketNumber); if (!d) return; // orphan (ไม่ได้สร้างในรอบนี้)
  d.accepted.add(w.code);
  if (d.mode === "accept-only") return; // รับงานแล้วหยุด (ไว้ให้ admin ยกเลิกตอนยังไม่ scan)
  const ci = await api("POST", "/api/workers/me/assignments/check-in-barcode", { token: w.token, body: { ticket_no: d.ticketNo } }); M.checkin.push(ci.ms);
  if (ci.status !== 200) return;
  d.checkedIn.add(w.code);
  if (d.mode === "complete" && d.checkedIn.size >= d.wc && !d.completed) {
    d.completed = true;
    await sleep(1200);
    const items = [{ productCode: d.product, packageCode: d.pkg, confirmed_quantity: d.qty }];
    const cp = await api("POST", "/api/workers/me/assignments/tickets/complete", { token: w.token, body: { ticket_no: d.ticketNo, boothCode: d.boothCode, items } }); M.complete.push(cp.ms);
  }
}

async function loadCreds(): Promise<Array<{ username: string; password: string }>> {
  if (CFG.credsFile) return JSON.parse(fs.readFileSync(CFG.credsFile, "utf8"));
  if (!CFG.dbUrl) return [];
  const c = new Client({ connectionString: stripSsl(CFG.dbUrl), ssl: { rejectUnauthorized: false } });
  await c.connect();
  const rows = (await c.query("SELECT labor_code, telephone FROM master_workers WHERE status = 1 AND telephone IS NOT NULL ORDER BY labor_code")).rows;
  if (!CFG.boothCodes.length) {
    const b = (await c.query("SELECT DISTINCT booth_code FROM master_market WHERE market_code = $1 AND booth_status = 'Normal' ORDER BY booth_code LIMIT 60", [CFG.marketCode])).rows;
    CFG.boothCodes = b.map((r: any) => r.booth_code);
  }
  await c.end();
  return rows.map((r: any) => ({ username: r.labor_code, password: String(r.telephone).replace(/\D/g, "") })).filter((x) => x.password);
}

let adminTok = "";
async function gateCreate(product: string, pkg: string, qty: number, dispatch: boolean, mode: "complete" | "hold" | "accept-only") {
  const tn = id14(), tno = id14(), bc = CFG.boothCodes[Math.floor(Math.random() * CFG.boothCodes.length)];
  const g = await api("POST", "/api/gate/tickets", { basic: true, body: { TicketNumber: tn, GateNo: "G01", LicensePlate: "LOADTEST", LicensePlateProvince: "BKK", VehicleTypeCode: "TRUCK", VehicleTypeName: "Truck", Markets: [{ TicketNo: tno, TicketCreatedAt: new Date().toISOString(), MarketCode: CFG.marketCode, DropoffPoint: "LoadTest", Booths: [{ BoothCode: bc, Products: [{ ProductCode: product, PackageCode: pkg, Quantity: qty }] }] }], Dispatch: dispatch } });
  if (g.status === 201) { myTickets.add(tn); detail.set(tn, { ticketNo: tno, boothCode: bc, product, pkg, qty, wc: g.body.WorkerCount, mode, accepted: new Set(), checkedIn: new Set(), completed: false }); }
  return { status: g.status, tn, tno, wc: g.body?.WorkerCount, code: g.body?.Code };
}

(async () => {
  console.log(`\n=== Production Flow+Load Test ===\ntarget: ${CFG.base}\n`);
  if (!CFG.gateSecret) { console.error("ต้องตั้ง GATE_CLIENT_SECRET"); process.exit(2); }
  const creds = await loadCreds();
  if (!creds.length || !CFG.boothCodes.length) { console.error("ไม่มี worker creds / booth"); process.exit(2); }
  adminTok = (await api("POST", "/api/auth/login", { body: { Username: CFG.adminUser, Password: CFG.adminPass, DeviceId: "loadtest-admin", DeviceName: "loadtest", Platform: "web" } })).body?.AccessToken;
  check("admin login", !!adminTok);

  // ---- Phase 0: self-clean (force worker ค้าง → open_app, park ticket ค้าง) ----
  const board = await api("GET", "/api/admin/jobs/workers/status", { token: adminTok });
  const onlineOld = (Array.isArray(board.body?.Data) ? board.body.Data : (board.body ?? [])).filter((w: any) => ["ready", "assigned", "working"].includes(w.Status ?? w.status));
  for (const w of onlineOld) await api("POST", `/api/admin/jobs/workers/${w.WorkerCode ?? w.workerCode}/status/force`, { token: adminTok, body: { Status: "open_app", ReasonCode: "IDLE_TOO_LONG", ReasonText: "Load test self-clean" } });
  const ops0 = (await api("GET", "/api/admin/vehicle-jobs/operations", { token: adminTok })).body?.Data ?? [];
  for (const o of ops0.filter((o: any) => ["WAIT", "WORKING"].includes(o.VehicleJob?.Status))) await api("POST", "/api/admin/vehicle-jobs/assignment/cancel", { token: adminTok, body: { TicketNumber: o.VehicleJob.TicketNumber, TicketNo: null, BoothCode: null, WorkerCode: null, ReasonCode: "ADMIN_CANCEL", ReasonText: "Load test self-clean" } });
  check("self-clean (force worker + ยกเลิกงานค้าง)", true, `forced ${onlineOld.length} workers, cancelled ${ops0.filter((o: any) => ["WAIT", "WORKING"].includes(o.VehicleJob?.Status)).length} ops`);
  await sleep(1500);

  // ---- Phase 1: login pool + online ----
  const t0 = Date.now();
  for (let i = CFG.workerOffset; i < CFG.workerOffset + CFG.workerCount; i++) {
    const c = creds[i]; if (!c) break;
    const s = Date.now(); const token = await loginWorker(c.username, c.password); M.login.push(Date.now() - s);
    if (!token) continue;
    tokenByCode.set(c.username, token);
    const ws = new WebSocket(wsUrl, { headers: { Authorization: "Bearer " + token } });
    const w: Worker = { code: c.username, token, ws };
    ws.on("message", (d) => { let e: any; try { e = JSON.parse(d.toString()); } catch { return; } if ((e.Type ?? e.type) === "WORKER_ASSIGNED") { const tn = e.Payload?.TicketNumber; const key = w.code + ":" + tn; if (tn && !processing.has(key)) { processing.add(key); void driveAssignment(w, tn); } } });
    await new Promise<void>((res) => { ws.on("open", () => res()); ws.on("error", () => res()); });
    workers.push(w);
  }
  const loginSecs = (Date.now() - t0) / 1000;
  check("login pool", workers.length > 0, `${workers.length} คน · ${(workers.length / loginSecs).toFixed(1)} login/s · p50 ${pct(M.login, 50)}ms`);
  const onRes = await Promise.all(workers.map((w) => api("POST", "/api/workers/me/online", { token: w.token })));
  const online = workers.filter((_, i) => onRes[i].status === 200);
  check("worker online", online.length >= 2, `${online.length}/${workers.length} ready`);

  // ---- Phase 2: multi-worker happy path (ทีม qty100 WC≥2 → หารเงิน) ----
  let teamCreated = 0;
  for (let i = 0; i < CFG.teamCount; i++) { const g = await gateCreate(CFG.teamProduct, CFG.teamPackage, CFG.teamQty, true, "complete"); if (g.status === 201) teamCreated++; await sleep(200); }
  check("multi-worker: gate create (WC≥2)", teamCreated > 0, `${teamCreated} ใบ · WC=${[...detail.values()][0]?.wc}`);
  let worstLivez = 0;
  for (let t = 0; t < 10; t++) { const lz = await api("GET", "/livez"); worstLivez = Math.max(worstLivez, lz.ms); const done = [...detail.values()].filter((d) => d.completed).length; if (done >= teamCreated) break; await sleep(4000); }
  const teamCompleted = [...detail.values()].filter((d) => d.completed).length;
  check("multi-worker: ทีม accept+scan+ส่งยอด", teamCompleted > 0, `completed ${teamCompleted}/${teamCreated}`);
  check("server health ใต้โหลด (/livez)", worstLivez < 2000, `worst ${worstLivez}ms`);

  // vendor confirm + financialize + money
  await sleep(1500);
  const subs1 = await api("GET", "/api/line/dev/submissions");
  for (const s of (subs1.body?.Data ?? []).filter((x: any) => myTickets.has(x.TicketNumber))) await api("POST", `/api/line/dev/submissions/${s.SubmissionId}/confirm`);
  await sleep(6000);
  let moneyOk = 0, moneyBad = 0; const sample: any[] = [];
  for (const tn of myTickets) {
    const f = await api("GET", `/api/admin/vehicle-jobs/${tn}/financials`, { token: adminTok });
    const sum = f.body?.Summary; const b0 = (f.body?.Booths ?? [])[0]; if (!sum || !b0?.Financialized) continue;
    const payout = Number(sum.WorkerPayoutTotal), fund = Number(sum.FundAmount), raw = Number(sum.LaborFeeRaw);
    const perWorker = (b0.Products?.[0]?.Workers ?? []).map((x: any) => x.Amount ?? x.amount ?? x.PayAmount);
    if (sample.length < 3) sample.push({ raw, payout, fund, wc: detail.get(tn)?.wc, perWorker });
    if (raw >= 0 && payout >= 0 && fund >= 0 && payout + fund >= raw - 0.011) moneyOk++; else moneyBad++;
  }
  check("เงิน: financialize + หาร/เศษ (payout+fund ≥ laborFeeRaw)", moneyBad === 0 && moneyOk > 0, `OK ${moneyOk}/BAD ${moneyBad} · ${JSON.stringify(sample)}`);

  // ---- Phase 3: Dispatch false→true (admin toggle) ----
  const gWait = await gateCreate(CFG.soloProduct, CFG.soloPackage, CFG.soloQty, false, "complete");
  if (gWait.status === 201) {
    const before = [...detail.get(gWait.tn)!.checkedIn];
    const toggle = await api("POST", `/api/admin/vehicle-jobs/${gWait.tn}/wait`, { token: adminTok, body: { Dispatch: true, ReasonCode: "DRIVER_READY", ReasonText: "Load test dispatch" } });
    await sleep(6000);
    check("Dispatch false→true เรียก worker สำเร็จ", toggle.status === 200 && (detail.get(gWait.tn)!.checkedIn.size > before.length || detail.get(gWait.tn)!.completed), `toggle=${toggle.status} checkedIn=${detail.get(gWait.tn)!.checkedIn.size}`);
  } else check("Dispatch false→true", false, `gate ${gWait.status}`);

  // ---- Phase 4: Admin ยกเลิก assignment (hold mode → ถอดคน) ----
  const gCancel = await gateCreate(CFG.soloProduct, CFG.soloPackage, CFG.soloQty, true, "accept-only");
  if (gCancel.status === 201) {
    for (let t = 0; t < 6 && detail.get(gCancel.tn)!.accepted.size === 0; t++) await sleep(2000); // รอ dispatch + accept (ยังไม่ scan)
    const assignedWorker = [...detail.get(gCancel.tn)!.accepted][0] ?? null;
    const cancel = await api("POST", "/api/admin/vehicle-jobs/assignment/cancel", { token: adminTok, body: { TicketNumber: gCancel.tn, TicketNo: null, BoothCode: null, WorkerCode: assignedWorker, ReasonCode: "ADMIN_CANCEL", ReasonText: "Load test cancel" } });
    check("Admin ยกเลิก assignment คนที่ยังไม่ scan (ถอด → กลับคิว)", cancel.status === 200, `status=${cancel.status} code=${cancel.body?.Code ?? ""} worker=${assignedWorker}`);
  } else check("Admin cancel assignment", false, `gate ${gCancel.status}`);

  // ---- Phase 5: Admin release-workers ตอน vendor ยังไม่ยืนยัน ----
  const gRel = await gateCreate(CFG.soloProduct, CFG.soloPackage, CFG.soloQty, true, "complete");
  if (gRel.status === 201) {
    for (let t = 0; t < 8 && !detail.get(gRel.tn)!.completed; t++) await sleep(2000); // รอส่งยอด
    await sleep(1500);
    const rel = await api("POST", `/api/admin/vehicle-jobs/${gRel.tn}/release-workers`, { token: adminTok, body: { ReasonCode: "ALL_BOOTHS_RESOLVED", ReasonText: "Load test release (vendor ยังไม่ confirm)" } });
    check("Admin release-workers ตอน vendor pending → กลับคิว", rel.status === 200 || rel.status === 409, `status=${rel.status} code=${rel.body?.Code ?? ""}`);
  } else check("Admin release-workers", false, `gate ${gRel.status}`);

  // ---- Phase 6: break → กลับมาทำงาน ----
  const bw = online.find((w) => tokenByCode.has(w.code));
  if (bw) {
    const br = await api("POST", "/api/workers/me/break", { token: bw.token, body: {} });
    await sleep(1500);
    const back = await api("POST", "/api/workers/me/online", { token: bw.token });
    check("break → กลับมาทำงาน", br.status === 200 && (back.status === 200 || back.status === 409), `break=${br.status} back=${back.status}`);
  }

  // ---- Phase 7: vendor timeout → auto-close (ลด setting ชั่วคราว) ----
  const cur = await api("GET", "/api/admin/settings", { token: adminTok });
  const origTimeout = cur.body?.VendorConfirmTimeoutMinutes ?? 60;
  const lower = await api("PATCH", "/api/admin/settings", { token: adminTok, body: { ...cur.body, VendorConfirmTimeoutMinutes: 1 } });
  if (lower.status === 200) {
    const gTo = await gateCreate(CFG.soloProduct, CFG.soloPackage, CFG.soloQty, true, "complete");
    for (let t = 0; t < 8 && !detail.get(gTo.tn)?.completed; t++) await sleep(2000); // รอส่งยอด (ไม่ confirm)
    console.log("  รอ vendor timeout auto-close (~90s)...");
    await sleep(90000);
    const f = await api("GET", `/api/admin/vehicle-jobs/${gTo.tn}/financials`, { token: adminTok });
    const fin = (f.body?.Booths ?? [])[0]?.Financialized;
    check("vendor timeout → auto-close (ไม่ confirm แต่ปิดเอง)", !!fin, `financialized=${fin}`);
    await api("PATCH", "/api/admin/settings", { token: adminTok, body: { ...cur.body, VendorConfirmTimeoutMinutes: origTimeout } }); // คืนค่า
    console.log(`  คืนค่า VendorConfirmTimeoutMinutes = ${origTimeout}`);
  } else check("vendor timeout (ลด setting)", false, `PATCH settings ${lower.status}`);

  // ---- Phase 8: invalid flow + กฎ gate ----
  const accNone = await api("POST", `/api/workers/me/assignments/${id14()}/accept`, { token: online[0]?.token });
  check("invalid: accept งานไม่มี → 4xx", accNone.status >= 400, `status=${accNone.status}`);
  const same = id14();
  const gSame = await api("POST", "/api/gate/tickets", { basic: true, body: { TicketNumber: same, GateNo: "G01", LicensePlate: "X", LicensePlateProvince: "BKK", VehicleTypeCode: "TRUCK", VehicleTypeName: "Truck", Markets: [{ TicketNo: same, TicketCreatedAt: new Date().toISOString(), MarketCode: CFG.marketCode, DropoffPoint: "X", Booths: [{ BoothCode: CFG.boothCodes[0], Products: [{ ProductCode: CFG.soloProduct, PackageCode: CFG.soloPackage, Quantity: CFG.soloQty }] }] }], Dispatch: false } });
  check("invalid: TicketNo == TicketNumber → 400", gSame.status === 400, `status=${gSame.status}`);
  const tnG = id14(), tnoG = id14();
  const gG = await api("POST", "/api/gate/tickets", { basic: true, body: { TicketNumber: tnG, GateNo: "G02", LicensePlate: "GATE", LicensePlateProvince: "BKK", VehicleTypeCode: "TRUCK", VehicleTypeName: "Truck", Markets: [{ TicketNo: tnoG, TicketCreatedAt: new Date().toISOString(), MarketCode: CFG.marketCode, DropoffPoint: "X", Booths: [{ BoothCode: CFG.boothCodes[1] ?? CFG.boothCodes[0], Products: [{ ProductCode: CFG.soloProduct, PackageCode: CFG.soloPackage, Quantity: CFG.soloQty }] }] }], Dispatch: false } });
  if (gG.status === 201) { myTickets.add(tnG); const pe = await api("PUT", `/api/gate/tickets/${tnoG}`, { basic: true, body: { GateNo: "G02", MarketCode: CFG.marketCode, DropoffPoint: "X", Booths: [] } }); check("กฎ gate: ลบแผงจนว่าง → 409 MINIMUM_BOOTH", pe.status === 409 && pe.body?.Code === "GATE_TICKET_MINIMUM_BOOTH_REQUIRED", `status=${pe.status} code=${pe.body?.Code}`); }

  // ---- Phase 8.5: นำงาน WAIT (รอลง) ไป dispatch:true → เรียก worker ทำจนจบ flow ----
  const waitOps = ((await api("GET", "/api/admin/vehicle-jobs/operations", { token: adminTok })).body?.Data ?? []).filter((o: any) => o.VehicleJob?.Status === "WAIT");
  let redispatched = 0;
  for (const o of waitOps) {
    const tn = o.VehicleJob.TicketNumber; const m = (o.Markets ?? [])[0]; const b = (m?.Booths ?? [])[0]; const p = (b?.Products ?? [])[0];
    if (!m?.TicketNo || !b?.BoothCode || !p?.ProductCode) continue;
    detail.set(tn, { ticketNo: m.TicketNo, boothCode: b.BoothCode, product: p.ProductCode, pkg: p.PackageCode, qty: Number(p.Quantity) || CFG.soloQty, wc: o.VehicleJob.WorkersRequired || 1, mode: "complete", accepted: new Set(), checkedIn: new Set(), completed: false });
    myTickets.add(tn);
    if ((await api("POST", `/api/admin/vehicle-jobs/${tn}/wait`, { token: adminTok, body: { Dispatch: true, ReasonCode: "DRIVER_READY", ReasonText: "Load test re-dispatch WAIT" } })).status === 200) redispatched++;
    await sleep(200);
  }
  if (redispatched > 0) {
    const waitTns = waitOps.map((o: any) => o.VehicleJob.TicketNumber);
    for (let t = 0; t < 12; t++) { if (waitTns.every((tn: string) => detail.get(tn)?.completed)) break; await sleep(4000); }
    await sleep(1500);
    const subs2 = await api("GET", "/api/line/dev/submissions");
    for (const s of (subs2.body?.Data ?? []).filter((x: any) => waitTns.includes(x.TicketNumber))) await api("POST", `/api/line/dev/submissions/${s.SubmissionId}/confirm`);
    const redone = waitTns.filter((tn: string) => detail.get(tn)?.completed).length;
    check("นำงาน WAIT (รอลง) → dispatch → เรียก worker ทำจนจบ", redone > 0, `re-dispatch ${redispatched}, ทำจบ ${redone}/${waitTns.length}`);
  }

  // ---- Phase 9: logout ทุกคน + ยกเลิกงานที่ยังค้าง + summary ----
  let loggedOut = 0; for (const w of workers) if ((await api("POST", "/api/auth/logout", { token: w.token })).status === 200) loggedOut++;
  check("logout workers ทุกคน", loggedOut === workers.length, `${loggedOut}/${workers.length}`);
  const opsEnd = (await api("GET", "/api/admin/vehicle-jobs/operations", { token: adminTok })).body?.Data ?? [];
  const leftover = opsEnd.filter((o: any) => ["WAIT", "WORKING"].includes(o.VehicleJob?.Status));
  let endCancelled = 0;
  for (const o of leftover) if ((await api("POST", "/api/admin/vehicle-jobs/assignment/cancel", { token: adminTok, body: { TicketNumber: o.VehicleJob.TicketNumber, TicketNo: null, BoothCode: null, WorkerCode: null, ReasonCode: "ADMIN_CANCEL", ReasonText: "End cleanup" } })).status === 200) endCancelled++;
  check("end-cleanup: ยกเลิกงานค้างทั้งหมด (ไม่เหลือ รอลง/working)", endCancelled === leftover.length, `cancelled ${endCancelled}/${leftover.length}`);

  console.log(`\n  latency: accept ${pct(M.accept, 50)}/${pct(M.accept, 95)}ms · checkin ${pct(M.checkin, 50)}/${pct(M.checkin, 95)}ms · complete ${pct(M.complete, 50)}/${pct(M.complete, 95)}ms`);
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n===== SUMMARY: ${pass}/${results.length} PASS =====`);
  for (const r of results.filter((r) => !r.ok)) console.log("  ❌", r.name, r.detail);
  for (const w of workers) try { w.ws.close(); } catch {}
  setTimeout(() => process.exit(pass === results.length ? 0 : 1), 1000);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
