# Build context is the repository root:  docker build -f server/Dockerfile -t rms-api .
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY server server
RUN npm run -w server build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev -w server && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY db db
# Mount point for STORAGE_DRIVER=local with ALLOW_LOCAL_STORAGE=true; a new named volume takes this ownership.
RUN mkdir -p /data/files && chown node:node /data/files
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/server.js"]
