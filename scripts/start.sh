#!/bin/sh
# 프론트엔드 Next.js (3000) 백그라운드
HOSTNAME=0.0.0.0 PORT=3000 node /app/frontend/server.js &
# 백엔드 Hono (8080) 포그라운드
exec node /app/dist/main.js
