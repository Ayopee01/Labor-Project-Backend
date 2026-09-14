import * as Sentry from "@sentry/node";

/* -------------------------------------- Sentry Init -------------------------------------- */

// Config สำหรับ Sentry — อ่านค่าจาก env
const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: "production",
    tracesSampleRate: 0, 
  });
}

// Export Sentry
export { Sentry };
