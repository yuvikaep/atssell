# Build context is the repository root:  docker build -f web/Dockerfile -t rms-web .
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY web web
RUN npm run -w web build

FROM nginx:1.27-alpine
# The image fills ${...} settings in from the environment at start (nginx's envsubst on templates).
# Set TRUST_CF_CONNECTING_IP=on only where nothing but a Cloudflare tunnel can reach this container.
ENV TRUST_CF_CONNECTING_IP=off
COPY web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
