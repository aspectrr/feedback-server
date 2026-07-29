# --- Stage 1: install deps ---
FROM oven/bun:latest AS deps
WORKDIR /app
COPY package.json ./
RUN bun install --production

# --- Stage 2: runtime ---
FROM oven/bun:latest AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
