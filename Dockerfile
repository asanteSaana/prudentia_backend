# NFR-18 — runs from a documented container definition with no host-specific setup.
#
# Node 22 LTS matches the Azure App Service runtime stack targeted in Phase 8. Keep the
# two aligned: a local image on a different major than the deployed runtime is a class
# of "works on my machine" this project has no budget to debug.
FROM node:22-slim AS build

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build

FROM node:22-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --prod --frozen-lockfile

COPY --from=build /app/dist ./dist

# Azure supplies PORT; this is only the local default.
EXPOSE 8080

# NODE_ENV MUST be `production` here. routesCreator picks `__routes.js` only on that
# exact value, and a missing route file is SKIPPED, NOT AN ERROR — so any other value
# boots an app that answers /api/health and 404s everything else, silently.
CMD ["node", "dist/index.js"]
