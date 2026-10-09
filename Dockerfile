# Builds the home-screen app and serves it with nginx. Coolify deploys this directly.
FROM node:22-alpine AS build
WORKDIR /app
COPY index.html ./
COPY scripts ./scripts
COPY public ./public
RUN node scripts/build.mjs

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
