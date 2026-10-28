FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 3000

# As migrations rodam UMA vez, no serviço `migrate` do docker-compose,
# antes das instâncias subirem (não em cada instância, para não disputarem).
CMD ["bun", "run", "src/main.ts"]
