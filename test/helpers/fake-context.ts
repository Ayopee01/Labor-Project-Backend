// Import Types
import type { AppContext } from "../../src/types/shared/http.type";

/* -------------------------------------- Types -------------------------------------- */

// Type ข้อมูลตั้งต้นของ context ปลอม
export type FakeContextInput = {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  variables?: Record<string, unknown>;
};

// Type context ปลอมที่เก็บ status และ body ของ response ไว้ตรวจ
export type FakeContext = AppContext & { statusCode?: number; jsonBody?: unknown };

/* -------------------------------------- Functions -------------------------------------- */

// Function สร้าง Hono context ปลอมขั้นต่ำสำหรับทดสอบ middleware โดยไม่ต้องตั้ง server จริง
export function buildFakeContext(input: FakeContextInput = {}): FakeContext {
  const path = input.path ?? "/api/auth/login";
  const headers = input.headers ?? {};
  const variables = new Map(Object.entries(input.variables ?? {}));
  const context = {
    req: {
      method: input.method ?? "POST",
      path,
      url: `http://localhost${path}`,
      header: (name: string) => headers[name.toLowerCase()],
    },
    res: { status: 200, headers: new Headers() },
    get: (key: string) => variables.get(key),
    set: (key: string, value: unknown) => variables.set(key, value),
    json: (body: unknown, status: number) => {
      context.statusCode = status;
      context.jsonBody = body;
      return new Response(JSON.stringify(body), { status });
    },
    statusCode: undefined as number | undefined,
    jsonBody: undefined as unknown,
  };

  return context as unknown as FakeContext;
}
