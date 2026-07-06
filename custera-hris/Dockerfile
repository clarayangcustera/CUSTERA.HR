FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json

RUN npm ci --include=dev --no-audit --no-fund

COPY apps ./apps

RUN npm run build --workspace=@custera/web

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "apps/api/src/server.js"]
