// Import Library
import * as Sentry from "@sentry/node";

/* -------------------------------------- Sentry Init -------------------------------------- */

// Config สำหรับ Sentry — อ่านค่าจาก env
const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: "production",
    tracesSampleRate: 0,
    // v11 เก็บ body/header/cookie/ตัวแปร local เป็นค่า default — ปิดทั้งหมดกันรหัสผ่านและ token หลุด
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
  });
}

// Config export Sentry ที่ init แล้วให้ส่วนอื่นใช้
export { Sentry };
