/* -------------------------------------- Test Env Guard -------------------------------------- */

const FORBIDDEN_DATABASE_PATTERNS = [
  "prod",
  "production",
  "staging",
];

// Function ตรวจว่า DATABASE_URL ชี้ไป environment ที่ห้ามใช้กับ test หรือไม่
function includesForbiddenDatabaseName(databaseUrl: string): boolean {
  const normalized = databaseUrl.toLowerCase();

  return FORBIDDEN_DATABASE_PATTERNS.some((pattern) =>
    normalized.includes(pattern)
  );
}

// Function เติมท้ายด้วย "0" ให้ยาวอย่างน้อย 32 ตัวอักษร เพื่อผ่านเกณฑ์ความแข็งแรงของ Secret ที่
// jwt.ts/refresh-token-hash.ts เช็คตรงจุดที่ใช้จริง โดยไม่ทำให้ค่าที่ prefix ต่างกันชนกันเอง
function padSecret(base: string): string {
  return base.length >= 32 ? base : base.padEnd(32, "0");
}

// Function ตั้งค่า env แยกสำหรับ test ไม่ให้ชนข้อมูลจริง
export function applyIsolatedTestEnv(prefix = "test"): void {
  // Route test files ยิง POST /api/auth/login จริงแทบทุกเทสต์ (ไม่มี token cache) ไฟล์ที่มีหลายร้อย
  // เทสต์จึงชน default RATE_LIMIT_MAX_REQUESTS ได้ง่ายเมื่อมีเทสต์เพิ่มขึ้นเรื่อยๆ (พิสูจน์แล้วจริงตอน
  // เพิ่มเทสต์ HistoryFlags 4 ตัว) — ยกเพดานเฉพาะ process ของ test เท่านั้น ไม่กระทบ production/security จริง
  process.env.RATE_LIMIT_MAX_REQUESTS ??= "5000";
  process.env.RATE_LIMIT_WINDOW_MS ??= "60000";
  process.env.RATE_LIMIT_CLEANUP_INTERVAL_MS ??= "60000";
  process.env.SHUTDOWN_TIMEOUT_MS ??= "20000";
  process.env.CORS_ORIGIN ??= "*";
  process.env.JWT_ACCESS_SECRET ??= padSecret(`${prefix}-access-secret`);
  process.env.JWT_REFRESH_SECRET ??= padSecret(`${prefix}-refresh-secret`);
  process.env.JWT_LOGIN_CHALLENGE_SECRET ??= padSecret(`${prefix}-login-challenge-secret`);
  process.env.REFRESH_TOKEN_HASH_SECRET ??= padSecret(`${prefix}-refresh-hash-secret`);
  process.env.LINE_CHANNEL_SECRET ??= `${prefix}-line-channel-secret`;
  process.env.SPACES_ENDPOINT ??= "https://sgp1.digitaloceanspaces.com";
  process.env.SPACES_REGION ??= "sgp1";
  process.env.SPACES_ACCESS_KEY ??= `${prefix}-spaces-access-key`;
  process.env.SPACES_SECRET_KEY ??= `${prefix}-spaces-secret-key`;
  process.env.SPACES_ADMIN_BUCKET ??= `${prefix}-admin-uploads`;
  // Redis ของ docker-compose.yml ตัวนี้ map host port เป็น 6380 (REDIS_HOST_PORT default) ไม่ใช่ 6379
  process.env.REDIS_URL ??= "redis://localhost:6380/15";
  process.env.WORKER_PRESENCE_STALE_SECONDS ??= "90";
  process.env.REDIS_WORKER_QUEUE_KEY = `${prefix}:worker:queue`;
  process.env.REDIS_WORKER_STATUS_KEY_PREFIX = `${prefix}:worker:status:`;
  process.env.REDIS_WORKER_PRESENCE_KEY_PREFIX = `${prefix}:worker:presence:`;
  process.env.REDIS_WORKER_BREAK_COUNT_KEY_PREFIX = `${prefix}:worker:break:`;
  // BullMQ queue name ห้ามมี ":" (validate จริงใน QueueBase) — route test ใช้ FakeQueue ที่ไม่เช็ค
  // format นี้เลยไม่เคยเจอปัญหา แต่ test ที่ต่อ Redis/BullMQ จริง (เช่น test/concurrency) ต้องใช้ชื่อ
  // ที่ผ่าน validation จริงได้ด้วย จึงใช้ "-" แทน ":" คั่น prefix
  process.env.BULLMQ_ASSIGNMENT_TIMEOUT_QUEUE = `${prefix}-assignment-timeout`;
  process.env.BULLMQ_WORKER_BREAK_RETURN_QUEUE = `${prefix}-worker-break-return`;
  process.env.BULLMQ_LINE_MESSAGE_QUEUE = `${prefix}-line-message`;
}

// Function ตรวจสอบ DATABASE_URL ของ test ก่อนรัน integration
export function assertSafeTestDatabaseUrl(databaseUrl = process.env.DATABASE_URL): void {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for DB integration tests.");
  }

  if (!databaseUrl.toLowerCase().includes("test")) {
    throw new Error("DATABASE_URL for DB integration tests must include 'test'.");
  }

  if (includesForbiddenDatabaseName(databaseUrl)) {
    throw new Error("DATABASE_URL appears to target a non-test environment.");
  }
}

// Function ตรวจสอบ REDIS_URL ของ test ก่อนรัน concurrency test — ห้ามชี้ไป Redis จริงที่ใช้งานอยู่
export function assertSafeTestRedisUrl(redisUrl = process.env.REDIS_URL): void {
  if (!redisUrl) {
    throw new Error("REDIS_URL is required for concurrency tests.");
  }

  if (includesForbiddenDatabaseName(redisUrl)) {
    throw new Error("REDIS_URL appears to target a non-test environment.");
  }

  const parsedDbIndex = Number(new URL(redisUrl).pathname.replace("/", "") || 0);

  // บังคับใช้ Redis logical DB index ที่ไม่ใช่ 0 (ค่า default ที่แอปจริง/dev ใช้) เพื่อแยกข้อมูล
  // test ออกจากข้อมูลจริงอย่างชัดเจน แม้ REDIS_URL จะชี้ไป host เดียวกับที่ dev ใช้อยู่ก็ตาม
  if (!parsedDbIndex) {
    throw new Error(
      "REDIS_URL for concurrency tests must use a non-default Redis DB index (e.g. redis://localhost:6379/15), never index 0 which the real app uses."
    );
  }
}
