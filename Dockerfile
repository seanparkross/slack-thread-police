# syntax=docker/dockerfile:1

FROM node:22-slim AS base
# Keep in step with the pnpm version used to write pnpm-lock.yaml.
ARG PNPM_VERSION=12.16.1
RUN npm install --global pnpm@${PNPM_VERSION}
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# The only thing the bot writes: who has turned nudges off (see DATA_DIR).
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data
USER node
CMD ["node", "dist/index.js"]
