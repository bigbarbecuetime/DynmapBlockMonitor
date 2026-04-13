FROM node:20-alpine

# Install build deps for native modules (better-sqlite3, sharp)
RUN apk add --no-cache python3 make g++ vips-dev

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server/ ./server/
COPY client/dist/ ./client/dist/

RUN mkdir -p /app/data/alerts

EXPOSE 3000

CMD ["node", "server/index.js"]
