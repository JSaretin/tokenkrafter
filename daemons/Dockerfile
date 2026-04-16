FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
RUN bun build ws-indexer.ts --outfile dist/ws-indexer.mjs --target node --minify && \
    bun build safu-indexer.ts --outfile dist/safu-indexer.mjs --target node --minify && \
    bun build activity-bot.ts --outfile dist/activity-bot.mjs --target node --minify && \
    bun build rate-updater.ts --outfile dist/rate-updater.mjs --target node --minify

FROM oven/bun:1-alpine
WORKDIR /app
COPY --from=build /app/dist/ ./
