// Import Library
import pino from "pino";

/* -------------------------------------- Logger Config -------------------------------------- */

// Config options ของ pino logger
const baseOptions: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL || "info",
  base: null,
  messageKey: "message",
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  formatters: {
    level: (label) => ({ level: label }),
  },
};

// Config pino logger หลักที่เขียนออก stdout
export const pinoLogger = pino(baseOptions, process.stdout);
