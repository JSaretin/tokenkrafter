FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
RUN bun build src/ws-indexer.ts --outfile dist/ws-indexer.mjs --target node --minify && \
    bun build src/safu-indexer.ts --outfile dist/safu-indexer.mjs --target node --minify && \
    bun build src/activity-bot.ts --outfile dist/activity-bot.mjs --target node --minify && \
    bun build src/rate-updater.ts --outfile dist/rate-updater.mjs --target node --minify && \
    bun build src/launch-buy-bot.ts --outfile dist/launch-buy-bot.mjs --target node --minify && \
    bun build src/popular-tokens-updater.ts --outfile dist/popular-tokens-updater.mjs --target node --minify

FROM oven/bun:1-alpine
WORKDIR /app
COPY --from=build /app/dist/ ./
