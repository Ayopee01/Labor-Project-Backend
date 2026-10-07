// Import Helpers
import { state } from "./app-test-state";

/* -------------------------------------- Fake Infra -------------------------------------- */

// Class จำลอง Redis แบบ in-memory
export class FakeRedis {
  static hashes = new Map<string, Record<string, string>>();
  static zsets = new Map<string, Map<string, number>>();
  static strings = new Map<string, number>();
  static instances = new Set<FakeRedis>();
  status = "ready";
  private subscribedChannels = new Set<string>();
  private eventHandlers = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(..._args: unknown[]) {
    FakeRedis.instances.add(this);
  }

  async connect(): Promise<void> {
    this.status = "ready";
  }

  // Function จำลอง subscribe ของ ioredis (ได้ message จากทุก instance ที่ publish)
  async subscribe(...channels: string[]): Promise<void> {
    channels.forEach((channel) => this.subscribedChannels.add(channel));
  }

  async publish(channel: string, message: string): Promise<number> {
    let receiverCount = 0;

    for (const instance of FakeRedis.instances) {
      if (!instance.subscribedChannels.has(channel)) {
        continue;
      }

      receiverCount += 1;

      for (const handler of instance.eventHandlers.get("message") ?? []) {
        handler(channel, message);
      }
    }

    return receiverCount;
  }

  on(event: string, handler: (...args: unknown[]) => void): this {
    const handlers = this.eventHandlers.get(event) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(event, handlers);

    return this;
  }

  async ping(): Promise<string> {
    if (process.env.TEST_READY_REDIS_FAIL === "1") {
      throw new Error("test redis unavailable");
    }

    return "PONG";
  }

  async quit(): Promise<void> {
    this.status = "end";
    FakeRedis.instances.delete(this);
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    const set = FakeRedis.zsets.get(key) ?? new Map<string, number>();
    set.set(member, Number(score));
    FakeRedis.zsets.set(key, set);
  }

  async zrange(
    key: string,
    start: number,
    stop: number,
    withScores?: string,
  ): Promise<string[]> {
    const items = Array.from(FakeRedis.zsets.get(key)?.entries() ?? [])
      .sort(([leftMember, leftScore], [rightMember, rightScore]) => {
        if (leftScore !== rightScore) {
          return leftScore - rightScore;
        }

        return leftMember.localeCompare(rightMember);
      })
      .slice(start, stop === -1 ? undefined : stop + 1);

    if (withScores === "WITHSCORES") {
      return items.flatMap(([member, score]) => [member, String(score)]);
    }

    return items.map(([member]) => member);
  }

  async zcard(key: string): Promise<number> {
    return FakeRedis.zsets.get(key)?.size ?? 0;
  }

  async zpopmin(key: string, count: number = 1): Promise<string[]> {
    const set = FakeRedis.zsets.get(key);

    if (!set || count <= 0) {
      return [];
    }

    const items = Array.from(set.entries())
      .sort(([leftMember, leftScore], [rightMember, rightScore]) => {
        if (leftScore !== rightScore) {
          return leftScore - rightScore;
        }

        return leftMember.localeCompare(rightMember);
      })
      .slice(0, count);

    for (const [member] of items) {
      set.delete(member);
    }

    return items.flatMap(([member, score]) => [member, String(score)]);
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    const set = FakeRedis.zsets.get(key);
    let removedCount = 0;

    members.forEach((member) => {
      if (set?.delete(member)) {
        removedCount += 1;
      }
    });

    return removedCount;
  }

  async zrank(key: string, member: string): Promise<number | null> {
    const items = Array.from(FakeRedis.zsets.get(key)?.entries() ?? [])
      .sort(([leftMember, leftScore], [rightMember, rightScore]) => {
        if (leftScore !== rightScore) {
          return leftScore - rightScore;
        }

        return leftMember.localeCompare(rightMember);
      })
      .map(([itemMember]) => itemMember);
    const index = items.indexOf(member);

    return index === -1 ? null : index;
  }

  async zscore(key: string, member: string): Promise<string | null> {
    const score = FakeRedis.zsets.get(key)?.get(member);

    return score === undefined ? null : String(score);
  }

  // Function ลงทะเบียน Lua command (fake ใช้ method JS ชื่อเดียวกันด้านล่างแทน)
  defineCommand(): void {}

  // Function จำลอง Lua setWorkerQueueState: เขียนสถานะ + เพิ่ม/ลบใน zset ในคำสั่งเดียว
  async setWorkerQueueState(statusKey: string, queueKey: string, ...args: string[]): Promise<string[]> {
    const [accountId, status, readyAt, breakUntil, openAppReason, nowIso, score] = args;
    const existing = FakeRedis.hashes.get(statusKey) ?? {};

    FakeRedis.hashes.set(statusKey, {
      ...existing,
      created_at: existing.created_at || nowIso,
      account_id: accountId,
      status,
      ready_at: readyAt,
      break_until: breakUntil,
      open_app_reason: openAppReason,
      updated_at: nowIso,
    });

    if (score === "") {
      FakeRedis.zsets.get(queueKey)?.delete(accountId);
    } else {
      await this.zadd(queueKey, Number(score), accountId);
    }

    return Object.entries(FakeRedis.hashes.get(statusKey) ?? {}).flat();
  }

  // Function จำลอง Lua popReadyWorkersAtomic: pop หัวคิวพร้อมเปลี่ยนเป็น assigned ทิ้งคนที่ไม่ใช่ ready
  async popReadyWorkersAtomic(
    queueKey: string,
    statusKeyPrefix: string,
    limit: string,
    readyStatus: string,
    assignedStatus: string,
    nowIso: string,
  ): Promise<string[]> {
    const result: string[] = [];

    while (result.length < Number(limit)) {
      const [accountId] = await this.zpopmin(queueKey, 1);

      if (accountId === undefined) {
        break;
      }

      const statusKey = `${statusKeyPrefix}${accountId}`;
      const existing = FakeRedis.hashes.get(statusKey) ?? {};

      if (existing.status !== readyStatus) {
        continue;
      }

      FakeRedis.hashes.set(statusKey, {
        ...existing,
        created_at: existing.created_at || nowIso,
        account_id: accountId,
        status: assignedStatus,
        ready_at: "",
        break_until: "",
        open_app_reason: "",
        updated_at: nowIso,
      });
      result.push(accountId);
    }

    return result;
  }

  // Function จำลอง Lua claimReadyWorkerAtomic: ดึงคนที่ระบุออกจากคิวพร้อมเปลี่ยนเป็น assigned
  async claimReadyWorkerAtomic(
    statusKey: string,
    queueKey: string,
    accountId: string,
    readyStatus: string,
    assignedStatus: string,
    nowIso: string,
  ): Promise<number> {
    if (!FakeRedis.zsets.get(queueKey)?.delete(accountId)) {
      return 0;
    }

    const existing = FakeRedis.hashes.get(statusKey) ?? {};

    if (existing.status !== readyStatus) {
      return 0;
    }

    FakeRedis.hashes.set(statusKey, {
      ...existing,
      created_at: existing.created_at || nowIso,
      account_id: accountId,
      status: assignedStatus,
      ready_at: "",
      break_until: "",
      open_app_reason: "",
      updated_at: nowIso,
    });

    return 1;
  }

  async hset(key: string, values: Record<string, string>): Promise<void> {
    FakeRedis.hashes.set(key, {
      ...(FakeRedis.hashes.get(key) ?? {}),
      ...values,
    });
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return { ...(FakeRedis.hashes.get(key) ?? {}) };
  }

  async expire(): Promise<void> {}

  async get(key: string): Promise<string | null> {
    const value = FakeRedis.strings.get(key);
    return value === undefined ? null : String(value);
  }

  async incr(key: string): Promise<number> {
    const value = (FakeRedis.strings.get(key) ?? 0) + 1;
    FakeRedis.strings.set(key, value);
    return value;
  }

  async del(key: string): Promise<void> {
    FakeRedis.hashes.delete(key);
    FakeRedis.zsets.delete(key);
    FakeRedis.strings.delete(key);
  }

  pipeline() {
    const commands: Array<() => Promise<unknown>> = [];

    return {
      hgetall: (key: string) => {
        commands.push(() => this.hgetall(key));
      },
      zrank: (key: string, member: string) => {
        commands.push(() => this.zrank(key, member));
      },
      exec: async () =>
        Promise.all(commands.map(async (command) => [null, await command()])),
    };
  }
}

// Class จำลอง BullMQ Queue
export class FakeQueue {
  name: string;

  constructor(name: string) {
    this.name = name;
    state.queueJobs.set(name, state.queueJobs.get(name) ?? new Map());
  }

  async add(_name: string, data: unknown, options: { jobId?: string } = {}) {
    const jobId = options.jobId ?? String(Date.now());
    state.queueJobs.get(this.name)?.set(jobId, {
      data,
      removed: false,
    });
  }

  async getJob(jobId: string) {
    const job = state.queueJobs.get(this.name)?.get(jobId);

    if (!job || job.removed) {
      return null;
    }

    return {
      getState: async () => job.state ?? "delayed",
      remove: async () => {
        // BullMQ จริงไม่ยอมลบ job ที่ worker กำลังประมวลผลอยู่ (locked) — จำลองพฤติกรรมเดียวกัน
        if (job.state === "active") {
          throw new Error(`Job ${jobId} could not be removed because it is locked by another worker`);
        }

        job.removed = true;
      },
    };
  }

  async close(): Promise<void> {}
}

// Class จำลอง BullMQ Worker
export class FakeWorker {
  constructor(
    name: string,
    processor: (job: { data: unknown }) => Promise<void>,
  ) {
    state.workerProcessors.set(name, processor);
  }

  on(): void {}

  async close(): Promise<void> {}
}
