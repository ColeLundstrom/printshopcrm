# PrintShopCRM
#
#   docker build -t printshopcrm .
#   docker run -p 3333:3333 -v printshopcrm-data:/data printshopcrm
#
# Or just `docker compose up -d`, which wires the volumes and .env for you.
#
# Node 22 is the floor: the app uses the built-in node:sqlite module, so there is no native
# database driver to compile and this image needs no build toolchain at all.

FROM node:22-alpine

# tini reaps zombies and forwards signals, so `docker stop` shuts the app down cleanly instead of
# waiting out the 10s kill timeout. wget is used by the healthcheck below.
RUN apk add --no-cache tini wget

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so a code change doesn't invalidate the npm layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Data lives on a volume, never in the image or the app directory: a container rebuild must not
# take the shop's database or its customer artwork with it.
#   /data                 SQLite databases (PSC_DB)
#   /app/public/uploads   customer artwork and shop logos
ENV PSC_DB=/data/printshop.db
VOLUME ["/data", "/app/public/uploads"]

# `node` (uid 1000) ships with the base image. Running as root inside a container that serves the
# internet is the kind of default nobody revisits later.
RUN mkdir -p /data /app/public/uploads && chown -R node:node /data /app/public/uploads
USER node

EXPOSE 3333
ENV PORT=3333

# The app answers /health as soon as it can serve requests.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--no-warnings", "server.mjs"]
