# Build stage
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build || true

# Production stage
FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/*.ts ./
COPY --from=builder /app/lib ./lib

# Expose ports
# 3001 - WebSocket server for Gemini Bridge
EXPOSE 3001

CMD ["npx", "ts-node", "index.ts"]
