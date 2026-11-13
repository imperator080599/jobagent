# syntax=docker/dockerfile:1
# Image unique : API + interface + planificateur + worker, avec LibreOffice (rendu
# PDF des documents Word) et les polices à métriques compatibles Calibri/Arial/Cambria.
FROM node:22-bookworm-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-writer-nogui poppler-utils \
      fonts-crosextra-carlito fonts-crosextra-caladea fonts-liberation2 fonts-dejavu-core \
      ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ── Construction de l'interface ──
FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── Exécution ──
FROM base AS runtime
ENV NODE_ENV=production PORT=4000 DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY src ./src
COPY drizzle ./drizzle
COPY tsconfig.json tsconfig.server.json ./
# Utilisateur sans privilèges ; /data n'est utilisé que sans Postgres externe (base embarquée).
RUN useradd --create-home --uid 10001 app && mkdir -p /data && chown app:app /data
USER app
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "src/server.ts"]
