FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
RUN bun build src/index.ts --outfile dist/payment.mjs --target node --minify && \
    bun build src/withdrawal-processor.ts --outfile dist/processor.mjs --target node --minify && \
    bun build src/onramp-delivery.ts --outfile dist/onramp-delivery.mjs --target node --minify

FROM oven/bun:1-alpine
WORKDIR /app
COPY --from=build /app/dist/ ./
