# PrintShopCRM
#
#   docker build -t printshopcrm .
#   docker run -p 3333:3333 -e PSC_AUTH=1 -e PSC_SECRET=$(openssl rand -hex 32) \
#     -v printshopcrm-data:/data printshopcrm
#
# PSC_AUTH=1 is what turns logins on; without it anyone who can reach the port has the whole app
# and the whole API. PSC_SECRET signs every customer share link — leave it unset and the app falls
# back to a value published in this repository, so anyone can forge a link to any customer's
# documents. Neither is optional on a port you publish. See SECURITY.md.
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
# take the shop's database or its customer artwork with it. BOTH live under /data, and uploads
# reach it through a symlink rather than a second mount.
#
# That is not tidiness. Fly and Render ignore a Dockerfile VOLUME entirely — they persist only
# what their own config mounts, and both blueprints mount exactly one disk, at /data. So with
# uploads declared as a separate VOLUME, every `fly deploy` and every Render deploy silently
# deleted every art proof and shop logo the shop had ever uploaded. The database survived, so the
# filenames were all still in art_versions and settings: the app came back up looking healthy,
# with a broken image on every proof page, every customer approval link, and every PDF.
#
#   /data          SQLite databases (PSC_DB)
#   /data/uploads  customer artwork and shop logos, symlinked from /app/public/uploads
ENV PSC_DB=/data/printshop.db
VOLUME ["/data"]

# `node` (uid 1000) ships with the base image. Running as root inside a container that serves the
# internet is the kind of default nobody revisits later.
RUN mkdir -p /data/uploads && rm -rf /app/public/uploads && ln -s /data/uploads /app/public/uploads \
    && chown -R node:node /data /app/public
USER node

EXPOSE 3333
ENV PORT=3333

# The app answers /health as soon as it can serve requests.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--no-warnings", "server.mjs"]
