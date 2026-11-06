// Config สถานะของ account
export const ACCOUNT_STATUSES = ["active", "inactive"] as const;
// Type สถานะของ account
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];
