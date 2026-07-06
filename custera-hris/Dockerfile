# Build the React interface
FROM node:22-alpine AS web-build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm install
COPY apps ./apps
RUN npm run build -w @custera/web

# Production API that also serves the compiled interface
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm install --omit=dev
COPY apps/api ./apps/api
COPY --from=web-build /app/apps/web/dist ./apps/web/dist
EXPOSE 8080
CMD ["node", "apps/api/src/server.js"]
