# Build context: folder root proyek (agar db/init.sql ikut tersalin)
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app
COPY api/package.json api/package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY api/src ./src
COPY api/public ./public
COPY db ./db

RUN mkdir -p /data && chown node:node /data
USER node
ENV STORAGE_DIR=/data PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
