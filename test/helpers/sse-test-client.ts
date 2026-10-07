// Import Library
import http, { type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/* -------------------------------------- Types -------------------------------------- */

// Type SSE event ที่ parse จาก stream ที่ได้รับ
export type ParsedSseEvent = { id: string | null; event: string; data: Record<string, unknown> };

// Type client ทดสอบ SSE ที่เชื่อมต่อผ่าน HTTP จริง
export type SseTestClient = {
  // ข้อความดิบทั้งหมดที่ได้รับ
  text: () => string;
  events: () => ParsedSseEvent[];
  // รอให้ event ที่ server เขียนแล้วเดินทางมาถึง client
  flush: () => Promise<void>;
  isEnded: () => boolean;
  close: () => Promise<void>;
};

/* -------------------------------------- Functions -------------------------------------- */

// Function รอตามจำนวนมิลลิวินาที
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Function แยก stream SSE เป็นรายการ event (รองรับทั้ง "field: value" และ "field:value")
function parseSseEvents(raw: string): ParsedSseEvent[] {
  return raw
    .split("\n\n")
    .map((block) => block.split("\n"))
    .filter((lines) => lines.some((line) => line.startsWith("event:")))
    .map((lines) => {
      const field = (name: string): string | null => {
        const line = lines.find((item) => item.startsWith(`${name}:`));
        return line === undefined ? null : line.slice(name.length + 1).replace(/^ /, "");
      };

      return {
        id: field("id"),
        event: field("event") as string,
        data: JSON.parse(field("data") ?? "null"),
      };
    });
}

// Function เปิด SSE ผ่าน server HTTP ชั่วคราว (subscribe รับ response จริงของ server) รอจน subscribe เสร็จและ event แรกมาถึง
export async function openSseTestClient(
  subscribe: (response: ServerResponse) => Promise<void>,
): Promise<SseTestClient> {
  let subscribed: Promise<void> = Promise.resolve();
  const server = http.createServer((_req, res) => {
    subscribed = subscribe(res);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { port } = server.address() as AddressInfo;
  let raw = "";
  let ended = false;

  const request = http.get({ host: "127.0.0.1", port, path: "/" });
  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    request.once("response", resolve);
    request.once("error", reject);
  });

  response.setEncoding("utf8");
  response.on("data", (chunk: string) => {
    raw += chunk;
  });
  response.on("end", () => {
    ended = true;
  });
  // client ปิด connection เองตอน close() ไม่ต้องรายงาน error
  response.on("error", () => undefined);
  request.on("error", () => undefined);

  const flush = () => sleep(30);

  await subscribed;
  await flush();

  return {
    text: () => raw,
    events: () => parseSseEvents(raw),
    flush,
    isEnded: () => ended,
    close: async () => {
      request.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // ให้ server ประมวลผล "close" ของ connection (เอา client ออกจาก registry) ก่อนทำขั้นถัดไป
      await flush();
    },
  };
}
