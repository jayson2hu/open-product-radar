FROM node:24.20.0-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.mjs ./
COPY src ./src
RUN npm run build

FROM node:24.20.0-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4188 RADAR_MODE=production RADAR_DB_PATH=/app/data/radar-production.sqlite
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY server ./server
COPY workers ./workers
COPY scripts ./scripts
RUN mkdir -p /app/data /app/backups && chown -R node:node /app
USER node
EXPOSE 4188
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4188)+'/api/v1/health',{signal:AbortSignal.timeout(3000)}).then(async r=>{if(!r.ok||(await r.json()).status!=='ok')process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
