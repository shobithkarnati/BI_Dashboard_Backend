# Google Cloud Run image for the BlueWheel BI backend.
# Pinned to the multi-arch digest of node:22-slim (Docker Hub, last updated 2026-11-05) so every build uses
# the same base image. To update: read the current digest with
#   curl -s https://registry.hub.docker.com/v2/repositories/library/node/tags/22-slim   (field "digest")
# (or: docker buildx imagetools inspect node:22-slim), replace the sha256 below, rebuild and test.
FROM node:22-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js routes.js ./
COPY api ./api
COPY shared ./shared
USER node
# Cloud Run sets PORT (8080).
CMD ["node", "server.js"]
