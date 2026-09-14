import { state } from "./app-test-state";

/* -------------------------------------- Fake Infra -------------------------------------- */

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

  // Function จำลอง pub/sub ของ ioredis — instance ที่ subscribe channel ไว้จะได้ event "message"
  // ทุกครั้งที่ instance ไหน (รวมตัวเอง) publish เข้า channel เดียวกัน เหมือนพฤติกรรมจริงที่ทุก
  // connection ต่อ Redis ตัวเดียวกัน
  async subscribe(...channels: string[]): Promise<void> {
    channels.forEach((channel) => this.subscribedChannels.add(channel));
  }

  async unsubscribe(...channels: string[]): Promise<void> {
    channels.forEach((channel) => this.subscribedChannels.delete(channel));
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
      .slice(start, stop + 1);

    if (withScores === "WITHSCORES") {
      return items.flatMap(([member, score]) => [member, String(score)]);
    }

    return items.map(([member]) => member);
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
      remove: async () => {
        job.removed = true;
      },
    };
  }

  async close(): Promise<void> {}
}

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
