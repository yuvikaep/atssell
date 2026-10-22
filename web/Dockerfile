# Build context is the repository root:  docker build -f web/Dockerfile -t rms-web .
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json api/
COPY web/package.json web/
RUN npm ci
COPY web web
RUN npm run -w web build

FROM nginx:1.27-alpine
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
