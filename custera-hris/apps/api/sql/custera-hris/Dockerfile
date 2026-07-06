# Build the React web app separately so Vite is always installed for the build.
FROM node:20-bookworm-slim AS web-build

WORKDIR /build/apps/web

COPY apps/web/package.json ./
RUN npm install --include=dev --no-audit --no-fund

COPY apps/web ./
RUN npm run build

# Run only the API and serve the compiled web files from it.
FROM node:20-bookworm-slim

WORKDIR /app

COPY apps/api/package.json ./apps/api/package.json
WORKDIR /app/apps/api
RUN npm install --omit=dev --no-audit --no-fund

WORKDIR /app
COPY apps/api ./apps/api
COPY --from=web-build /build/apps/web/dist ./apps/web/dist

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "apps/api/src/server.js"]
