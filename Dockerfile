# Builds the diary app and runs the small server that serves it and stores your diary.
FROM node:22-alpine
WORKDIR /app
COPY index.html server.mjs ./
COPY scripts ./scripts
COPY public ./public
RUN node scripts/build.mjs
ENV DATA_DIR=/data PORT=3000
VOLUME /data
EXPOSE 3000
CMD ["node", "server.mjs"]
