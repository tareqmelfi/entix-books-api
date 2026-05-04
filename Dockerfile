# Multi-stage build for entix-books-api
# Stage 1: build (TS → JS · prisma generate)
FROM node:22-alpine AS builder

WORKDIR /app

# Install OS deps for prisma + native modules
RUN apk add --no-cache openssl

COPY package*.json ./
COPY prisma ./prisma
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src

# Generate Prisma client + compile TS
RUN npx prisma generate
RUN npm run build

# Stage 2: runtime
FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache openssl curl

# Copy only what runtime needs
COPY package*.json ./
COPY prisma ./prisma
RUN npm install --omit=dev --no-audit --no-fund

# Generated prisma client + compiled code
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Run migrations + start server
CMD npx prisma migrate deploy && node dist/server.js
