# ── Build ─────────────────────────────────────────────────────────────────
# Prisma generates a client from the schema, so the schema has to be present
# before the build and the generated client has to survive into the runtime
# image — it is imported as ordinary source, not resolved from node_modules.
FROM node:24-alpine AS build

WORKDIR /app

# Dependencies first: this layer is rebuilt only when the lockfile or the
# schema changes, both far less often than the source. The schema has to be
# here before `npm ci`, because a postinstall hook generates the Prisma client
# and there is nothing to generate from otherwise.
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./

# prisma.config.ts resolves DATABASE_URL, and the postinstall hook that
# generates the client reads it — so it has to be present even though nothing
# connects to a database while generating. Scoped to these commands rather
# than baked into the image, so no build-time value can survive into runtime
# and be mistaken for real configuration.
ARG PRISMA_BUILD_URL="postgresql://build:build@localhost:5432/build?schema=public"
RUN DATABASE_URL="$PRISMA_BUILD_URL" npm ci

COPY tsconfig*.json nest-cli.json ./
COPY src ./src

# Regenerated after the source is in place: the client is written *into* src,
# and the image builds it rather than trusting whatever the host had.
RUN DATABASE_URL="$PRISMA_BUILD_URL" npx prisma generate
RUN npm run build

# Drop to production dependencies for the runtime image. Done here rather than
# in the runtime stage so no build toolchain is needed there at all.
RUN DATABASE_URL="$PRISMA_BUILD_URL" npm ci --omit=dev && npm cache clean --force

# ── Runtime ───────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime

# dumb-init gives the process a real PID 1, so SIGTERM reaches Node and
# Nest's shutdown hooks run — which is what closes Redis, drains BullMQ
# workers and finishes in-flight requests instead of dropping them.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
WORKDIR /app

# Never root: a compromised process should not be able to rewrite its own
# application code.
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S deliver -G nodejs

COPY --from=build --chown=deliver:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=deliver:nodejs /app/dist ./dist
COPY --from=build --chown=deliver:nodejs /app/prisma ./prisma
COPY --chown=deliver:nodejs package.json ./

USER deliver
EXPOSE 3000

# The readiness probe the platform already exposes, so an unhealthy container
# is replaced rather than left in rotation.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
