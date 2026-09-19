# The acceptance suite needs no dependency: `node:test`, `node:assert` and the global `fetch` are all
# part of Node.js 22. The default command runs the phase-1 suite against a freshly reset stack;
# run-acceptance.sh / run-acceptance.ps1 overrides the command for every phase and does the
# container restarts between them (a black-box container has no Docker access).
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV BASE_URL=http://web
COPY package.json ./
COPY tests ./tests
USER node
CMD ["node", "--test", "--test-concurrency=1", "tests/behavior-preservation.test.mjs", "tests/concurrency.test.mjs"]
