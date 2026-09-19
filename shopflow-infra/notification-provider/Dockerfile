# Multi-stage build. The runtime stage needs no dependency: the emulator runs on the Node.js
# standard library only (node:http, node:fs, node:crypto, node:path, node:url).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY test ./test
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# The append-only JSONL store lives on the `notify_data` volume mounted at /data.
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 4010
CMD ["node", "dist/src/server.js"]
