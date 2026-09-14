export const WORKER_WORK_STATUS = {
  OPEN_APP: "open_app",
  READY: "ready",
  ASSIGNED: "assigned",
  WAITING_TEAM: "waiting_team",
  WORKING: "working",
  BREAK: "break",
} as const;

export const WORKER_WORK_STATUSES = Object.values(WORKER_WORK_STATUS);

// Type ค่า 6 สถานะการทำงานของ worker ที่ใช้ทั้ง project
export type WorkerWorkStatus = (typeof WORKER_WORK_STATUS)[keyof typeof WORKER_WORK_STATUS];
