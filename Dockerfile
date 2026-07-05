# ---- Stage 1: build the React client ----
FROM node:20-alpine AS client-build

WORKDIR /app/client

COPY client/package*.json ./
RUN npm ci

COPY client/ ./
RUN npm run build

# ---- Stage 2: runtime ----
FROM node:20-alpine

# Install build deps for native modules (better-sqlite3, sharp)
RUN apk add --no-cache python3 make g++ vips-dev

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server/ ./server/
COPY --from=client-build /app/client/dist/ ./client/dist/

RUN mkdir -p /app/data/alerts

EXPOSE 3000

CMD ["node", "server/index.js"]
