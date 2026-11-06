// Import Library
import dotenv from "dotenv";
import { Client } from "pg";
import IORedis from "ioredis";

dotenv.config({ quiet: true });

/* -------------------------------------- Config -------------------------------------- */

// ตารางที่ "เก็บไว้" (master/seed/config) — ที่เหลือถือเป็น transactional/test แล้วล้างทิ้ง
const KEEP_TABLES = new Set<string>([
  "master_market",
  "master_owner_stalls",
  "master_member_stalls",
  "master_product",
  "master_rate",
  "master_workers",
  "accounts",
  "account_permissions",
  "gate_clients",
  "system_settings",
  "mobile_app_versions",
]);

function stripSsl(cs: string): string {
  const u = new URL(cs);
  for (const k of [...u.searchParams.keys()]) if (k.startsWith("ssl") || k === "uselibpqcompat") u.searchParams.delete(k);
  return u.toString();
}

/* -------------------------------------- Main -------------------------------------- */

// Function ล้างข้อมูล transactional ใน DB (เหลือแค่ seed) + flush Redis ให้เหมือนเริ่มทดสอบใหม่
// dry-run เป็นค่าเริ่มต้น — ต้องส่ง --apply ถึงจะลบจริง
async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const dbUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is required.");

  const c = new Client({ connectionString: stripSsl(dbUrl), ssl: { rejectUnauthorized: false } });
  await c.connect();
  const dbHost = new URL(dbUrl).host;

  const tables: string[] = (
    await c.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name NOT LIKE '\\_prisma%' ORDER BY table_name"
    )
  ).rows.map((r) => r.table_name);

  const truncate = tables.filter((t) => !KEEP_TABLES.has(t));
  const keep = tables.filter((t) => KEEP_TABLES.has(t));

  console.log(`DB host: ${dbHost}`);
  console.log(`\n=== KEEP (${keep.length} ตาราง seed/master — ไม่แตะ) ===`);
  console.log("  " + keep.join(", "));
  console.log(`\n=== TRUNCATE (${truncate.length} ตาราง transactional/test) ===`);
  for (const t of truncate) {
    const n = (await c.query(`SELECT count(*)::int n FROM "${t}"`)).rows[0].n;
    console.log(`  ${String(n).padStart(6)}  ${t}`);
  }

  // Redis (เข้าไม่ถึงก็ข้าม — prod Redis ของ DO อยู่บน private network เข้าจากภายนอกไม่ได้)
  let redis: IORedis | null = null;
  let redisKeys = 0;
  if (redisUrl) {
    try {
      const r = new IORedis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true, connectTimeout: 5000 });
      r.on("error", () => undefined);
      await r.connect();
      redisKeys = Number(await r.dbsize());
      redis = r;
      console.log(`\n=== Redis ${new URL(redisUrl).host} === ${redisKeys} keys ${apply ? "(จะ FLUSHDB)" : "(dry-run)"}`);
    } catch (e) {
      console.log(`\n=== Redis: เข้าไม่ถึง (${(e as Error).message.slice(0, 60)}) — ข้าม, ต้อง flush จาก DO เอง ===`);
      redis = null;
    }
  }

  console.log(`\nmode: ${apply ? "APPLY (ลบจริง)" : "DRY-RUN (ไม่ลบ) — ใส่ --apply เพื่อลบจริง"}`);

  if (apply) {
    // TRUNCATE ต้อง ACCESS EXCLUSIVE lock — ตั้ง lock_timeout + retry ให้คว้า lock ในจังหวะ app ว่าง
    await c.query("SET lock_timeout = '4000ms'");
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let done = false;
    for (let attempt = 1; attempt <= 6 && !done; attempt++) {
      try {
        await c.query(`TRUNCATE TABLE ${truncate.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
        done = true;
      } catch (e) {
        console.log(`  TRUNCATE attempt ${attempt}/6 ติด lock (${(e as Error).message.slice(0, 40)}) — retry...`);
        await sleep(2500);
      }
    }
    if (!done) throw new Error("TRUNCATE ติด lock ทุกครั้ง — app ยังถือ lock อยู่ ต้องหยุด/พัก app ก่อนรันใหม่ (maintenance window)");
    console.log(`\n✅ TRUNCATE สำเร็จ ${truncate.length} ตาราง`);
    if (redis) { await redis.flushdb(); console.log(`✅ Redis FLUSHDB สำเร็จ (ล้าง ${redisKeys} keys)`); }
    console.log("\n⚠️ แนะนำ redeploy/restart app 1 ครั้ง เพื่อให้ BullMQ repeatable jobs (sweeps) ลงทะเบียนใหม่");
  }

  if (redis) await redis.quit().catch(() => undefined);
  await c.end();
}

void main().catch((e) => { console.error("reset-test-data failed:", e); process.exit(1); });
