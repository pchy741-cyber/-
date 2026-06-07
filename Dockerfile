# ── Stage 1: Build Frontend ──
FROM node:22-slim AS frontend-builder

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
COPY frontend/ ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── Stage 2: Build Backend ──
FROM node:22-slim AS backend-builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/

# Clean build: rm -rf dist → tsc (삭제된 .ts의 .js 잔류 원천 차단)
# Build hash: 빌드 시점 기록 → 부팅 시 검증 가능
RUN npm run build \
    && cp -r src/db/migrations dist/db/migrations \
    && echo "{\"builtAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"nodeVersion\":\"$(node -v)\"}" > dist/build-meta.json

# ── Stage 3: Production ──
FROM node:22-slim AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# 백엔드
COPY --from=backend-builder /app/dist ./dist

# 프론트엔드 standalone
COPY --from=frontend-builder /app/frontend/.next/standalone ./frontend
COPY --from=frontend-builder /app/frontend/.next/static ./frontend/.next/static
COPY --from=frontend-builder /app/frontend/public ./frontend/public

# 시작 스크립트
COPY scripts/start.sh /app/start.sh
RUN chmod +x /app/start.sh

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["/app/start.sh"]
