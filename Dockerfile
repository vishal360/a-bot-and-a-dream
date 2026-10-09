FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run check
# The server intentionally binds loopback. Run with host networking on Linux;
# do not publish this unauthenticated local control plane to a network.
CMD ["bun", "run", "start"]