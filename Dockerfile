FROM oven/bun:1.4.4-alpine AS base

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

ENV DATABASE_URL="postgresql://postgres:password@localhost:5432/labor_project"
COPY prisma.config.js ./
COPY prisma ./prisma
RUN bun run db:generate

COPY tsconfig.json ./
COPY index.ts ./
COPY src ./src

FROM oven/bun:1.4.4-alpine AS production-deps

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
ENV DATABASE_URL="postgresql://postgres:password@localhost:5432/labor_project"
COPY prisma.config.js ./
COPY prisma ./prisma
RUN bun run db:generate

FROM base AS dev

ENV NODE_ENV=development
EXPOSE 8080
CMD ["bun", "run", "dev"]

FROM oven/bun:1.4.4-alpine AS production

ARG OCI_SOURCE=""
ARG OCI_REVISION=""
ARG OCI_CREATED=""
ARG OCI_VERSION=""

LABEL org.opencontainers.image.source=$OCI_SOURCE \
  org.opencontainers.image.revision=$OCI_REVISION \
  org.opencontainers.image.created=$OCI_CREATED \
  org.opencontainers.image.version=$OCI_VERSION

WORKDIR /app
ENV NODE_ENV=production
# ขนาด pool DB (DB plan ปัจจุบันรับ 22 connection — 15 ปลอดภัย เผื่อโตถึง ~300-400 คน) override ด้วย env ของ platform ได้
ENV DATABASE_POOL_MAX=15

COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=production-deps /app/package.json ./
COPY --from=production-deps /app/prisma.config.js ./
COPY --from=production-deps /app/prisma ./prisma
COPY tsconfig.json index.ts ./
COPY src ./src

EXPOSE 8080
USER bun
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD bun -e "const port=process.env.PORT||8080; fetch('http://127.0.0.1:'+port+'/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# exec แทนที่ shell ด้วย bun โดยตรงหลัง migrate deploy เสร็จ เพื่อให้ bun เป็น PID 1 รับ SIGTERM ตรงๆ สำหรับ graceful shutdown (SHUTDOWN_TIMEOUT_MS)
CMD ["sh", "-c", "bun run db:deploy && exec bun index.ts"]
