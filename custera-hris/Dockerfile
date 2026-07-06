# Single-stage build to avoid an npm workspace install issue on hosted builders.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json

RUN npm install

COPY apps ./apps
RUN npm run build -w @custera/web

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "apps/api/src/server.js"]
