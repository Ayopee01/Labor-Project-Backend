import { state } from "./app-test-state";
import { buildLocalizedNotification, hasNotificationTemplate } from "../../src/utils/notification-localization";

// Function จำลอง resolveTicketResultAudience จริงใน realtime-notification.service.ts — คืนเฉพาะ
// worker id เท่านั้น (Admin กระจายแยกผ่าน publishRealtimeEvent's admin:true เสมอ ไม่พึ่ง id list นี้
// — ดู comment ในไฟล์จริงเรื่องทำไมห้ามรวม Account.id กับ MasterWorker.id เข้าด้วยกัน)
async function resolveTicketResultAudience(ticket: { id: number; market_job_id?: number }) {
  const marketJobId =
    ticket.market_job_id ??
    state.boothJobs.find((item) => item.id === ticket.id)?.market_job_id;
  const ticketWorkerIds = state.ticketWorkers
    .filter((worker) => worker.market_job_id === marketJobId)
    .map((worker) => worker.worker_id);

  return [...new Set(ticketWorkerIds)];
}

export const notificationServiceMock = {
  publishNotification: (event: unknown) => state.notifications.push(event),
  publishRealtimeEvent: (event: { payload?: unknown; worker_payload?: unknown }) =>
    // เลียนแบบ fallback ของ publishRealtimeEvent จริงใน realtime-notification.service.ts
    // (worker_payload = input.worker_payload ?? payload) เพื่อให้ event ที่ mock บันทึกไว้ตรงกับสิ่งที่
    // worker ได้รับจริง แม้ caller จะไม่ได้ส่ง worker_payload มาแยกต่างหาก
    state.realtimeEvents.push({
      ...event,
      worker_payload: event.worker_payload ?? event.payload ?? {},
    }),
  resolveTicketResultAudience,
  publishAdminWorkerStatusChanged: (event: {
    title: string;
    message: string;
    workerCode: string | null;
    queue: unknown;
    reason: string;
    extraPayload?: Record<string, unknown>;
  }) =>
    state.notifications.push({
      type: "WORKER_STATUS_CHANGED",
      title: event.title,
      message: event.message,
      payload: {
        worker_code: event.workerCode,
        queue: event.queue,
        reason: event.reason,
        ...(event.extraPayload ?? {}),
      },
      audience: {
        roles: ["admin"],
      },
    }),
};

export const realtimeNotificationServiceMock = {
  publishRealtimeEvent: (event: { payload?: unknown; worker_payload?: unknown }) =>
    // เลียนแบบ fallback ของ publishRealtimeEvent จริงใน realtime-notification.service.ts
    // (worker_payload = input.worker_payload ?? payload) เพื่อให้ event ที่ mock บันทึกไว้ตรงกับสิ่งที่
    // worker ได้รับจริง แม้ caller จะไม่ได้ส่ง worker_payload มาแยกต่างหาก
    state.realtimeEvents.push({
      ...event,
      worker_payload: event.worker_payload ?? event.payload ?? {},
    }),
  resolveTicketResultAudience,
  // Function จำลอง buildWorkerNotification จริง — ย้ายมาจาก notificationServiceMock ตาม Fix C
  buildWorkerNotification: (input: {
    type: string;
    lang?: string | null;
    notification_key?: string | null;
    fallbackTitle: string;
    fallbackMessage: string;
  }) => ({
    key: input.notification_key ?? input.type,
    lang: input.lang ?? "TH",
    title: input.fallbackTitle,
    message: input.fallbackMessage,
  }),
  // Function จำลอง persistWorkerNotification จริง — ย้ายมาจาก notificationServiceMock ตาม Fix C
  persistWorkerNotification: (input: {
    worker_id: number;
    type: string;
    notification_key?: string | null;
    lang?: string | null;
    title: string;
    message: string;
    payload?: unknown;
  }) => {
    const now = new Date().toISOString();

    state.workerNotifications.push({
      id: state.nextWorkerNotificationId++,
      worker_id: input.worker_id,
      type: input.type,
      notification_key: input.notification_key ?? null,
      lang: input.lang ?? "TH",
      title: input.title,
      message: input.message,
      payload: input.payload ?? null,
      read_at: null,
      created_at: now,
      updated_at: now,
    });
  },
  // Function จำลอง persistWorkerNotifications จริง — ย้ายมาจาก notificationServiceMock ตาม Fix C
  persistWorkerNotifications: (
    inputs: Array<{
      worker_id: number;
      type: string;
      notification_key?: string | null;
      lang?: string | null;
      title: string;
      message: string;
      payload?: unknown;
    }>,
  ) => {
    for (const input of inputs) {
      realtimeNotificationServiceMock.persistWorkerNotification(input);
    }
  },
  // Function จำลอง listWorkerNotifications จริง — ย้ายมาจาก notificationServiceMock ตาม Fix C
  // Re-localize ตามภาษาปัจจุบันของ worker เหมือน implementation จริงใน realtime-notification.service.ts
  // (ใช้ hasNotificationTemplate/buildLocalizedNotification ตัวจริงตรงๆ เพราะเป็น pure function ไม่ต้อง mock)
  listWorkerNotifications: async (
    query: { page?: string; limit?: string },
    auth?: { account_id?: number; role?: string },
  ) => {
    const page = Number(query.page ?? 1);
    const limit = Number(query.limit ?? 20);
    const filtered = state.workerNotifications
      .filter((item) => item.worker_id === auth?.account_id)
      .sort((left, right) =>
        right.created_at.localeCompare(left.created_at) || right.id - left.id
      );
    const currentLang = auth?.account_id
      ? state.workers.get(auth.account_id)?.lang
      : undefined;

    return {
      data: filtered.slice((page - 1) * limit, page * limit).map((item) => {
        const canRelocalize =
          Boolean(item.notification_key) &&
          Boolean(currentLang) &&
          hasNotificationTemplate(currentLang, item.notification_key as string);

        const localized = canRelocalize
          ? buildLocalizedNotification({
              type: item.type,
              lang: currentLang,
              key: item.notification_key,
              params:
                item.payload && typeof item.payload === "object" && !Array.isArray(item.payload)
                  ? (item.payload as Record<string, unknown>)
                  : undefined,
              fallbackTitle: item.title,
              fallbackMessage: item.message,
            })
          : { key: item.notification_key, lang: item.lang, title: item.title, message: item.message };

        return {
          id: item.id,
          type: item.type,
          notification_key: item.notification_key,
          lang: localized.lang,
          title: localized.title,
          message: localized.message,
          notification: {
            key: localized.key,
            lang: localized.lang,
            title: localized.title,
            message: localized.message,
          },
          payload: item.payload,
          read_at: item.read_at,
          created_at: item.created_at,
        };
      }),
      pagination: {
        page,
        limit,
        total: filtered.length,
        total_pages: Math.ceil(filtered.length / limit),
      },
    };
  },
};

export const workerSocketMock = {
  isWorkerSocketConnected: (workerId: number) =>
    state.connectedWorkers.has(workerId),
  sendWorkerSocketEvent: (
    workerId: number,
    event: string,
    payload: unknown,
  ) => {
    state.socketEvents.push({
      workerId,
      event,
      payload,
    });
  },
};

export const notificationQueueMock = {
  enqueueLineMessage: async (name: string, data: unknown) => {
    state.lineMessages.push({
      name,
      data,
    });
  },
  enqueueLoggedLineMessage: async (input: {
    jobName: string;
    targetLineUserId: string;
    messages: unknown;
  }) => {
    state.lineMessages.push({
      name: input.jobName,
      data: {
        log_id: 1,
        to: input.targetLineUserId,
        messages: input.messages,
      },
    });
    return 1;
  },
  // Function จำลอง sendLineReplyMessage จริงใน line-message-queue.ts — ยิงผ่าน Reply API แบบ
  // synchronous ไม่ผ่าน queue จึงบันทึกลง state.lineMessages ทันทีเหมือน enqueueLoggedLineMessage
  sendLineReplyMessage: async (replyToken: string, messages: unknown) => {
    state.lineMessages.push({
      name: "send-line-reply",
      data: {
        replyToken,
        messages,
      },
    });
  },
};

export const MESSAGE_DELIVERY_STATUS = {
  PENDING: "PENDING",
  SENT: "SENT",
  FAILED: "FAILED",
} as const;

// Mock ของ src/repositories/shared/message-delivery-log.repository.ts — ย้ายมาจาก lineRepositoryMock
// ตาม Fix D เพราะ table นี้ใช้ร่วมกันทั้ง fcm_push และ LINE channel
export const messageDeliveryLogRepositoryMock = {
  MESSAGE_DELIVERY_STATUS,
  createMessageDeliveryLog: async (
    channel: string,
    jobName: string,
    payload: unknown,
    target?: string | null,
  ) => {
    const now = new Date().toISOString();
    const record = {
      id: state.nextMessageDeliveryLogId++,
      channel,
      job_name: jobName,
      target: target ?? null,
      status: MESSAGE_DELIVERY_STATUS.PENDING,
      sent_at: null,
      created_at: now,
      updated_at: now,
    };

    state.messageDeliveryLogs.push(record);
    return record.id;
  },
  updateMessageDeliveryLogStatus: async (
    id: number,
    status: string,
    _error?: string | null,
  ) => {
    const record = state.messageDeliveryLogs.find((item) => item.id === id);

    if (!record) {
      return;
    }

    record.status = status;
    record.updated_at = new Date().toISOString();

    if (status === MESSAGE_DELIVERY_STATUS.SENT) {
      record.sent_at = record.updated_at;
    }
  },
};

// Mock ของ src/repositories/shared/line-action-token.repository.ts — ย้ายมาจาก lineRepositoryMock ตาม Fix D
export const lineActionTokenRepositoryMock = {
  createLineActionToken: async (input: {
    action: string;
    ticket_id: number;
    submission_id: number;
    boothCode: string;
  }) => {
    const now = new Date();
    const id = state.nextLineActionTokenId++;
    const record = {
      id,
      token: `line-action-token-${id}`,
      action: input.action,
      ticket_id: input.ticket_id,
      submission_id: input.submission_id,
      boothCode: input.boothCode,
      expires_at: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      used_at: null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };

    state.lineActionTokens.push(record);
    return record;
  },
};

export const lineRepositoryMock = {
  findLineActionToken: async (token: string) =>
    state.lineActionTokens.find((record) => record.token === token) ?? null,
  claimLineActionTokenUsed: async (id: number) => {
    const record = state.lineActionTokens.find((item) => item.id === id);

    if (!record || record.used_at !== null) {
      return false;
    }

    record.used_at = new Date().toISOString();
    return true;
  },
  upsertTicketRating: async (input: {
    ticket_id: number;
    submission_id: number;
    line_user_id: string;
    target_type?: string | null;
    score: number;
  }) => {
    const now = new Date().toISOString();
    const rating = state.ticketRatings.find(
      (item) => item.ticket_id === input.ticket_id,
    );

    if (!rating) {
      const newRating = {
        id: state.nextRatingId++,
        ticket_id: input.ticket_id,
        submission_id: input.submission_id,
        line_user_id: input.line_user_id,
        target_type: input.target_type ?? null,
        score: input.score,
        rated_at: now,
        created_at: now,
        updated_at: now,
      };
      state.ticketRatings.push(newRating);
      return newRating;
    }

    return rating;
  },
};
