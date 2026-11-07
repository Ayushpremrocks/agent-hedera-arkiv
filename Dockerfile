# The agent host: the API, every signed-in user's agent, the escrow keeper and the schedule loop.
# Run exactly one instance, with a persistent volume at /app/data/host (see "Deploy" in readme.md).
FROM node:22-slim
WORKDIR /app
RUN npm install -g pnpm@11.24.0
COPY . .
# shortcut: installs the whole workspace (the web app's packages too); filter to the host if image size matters.
RUN pnpm install --frozen-lockfile
EXPOSE 4100
# node directly (not pnpm), so a stop signal reaches the host and it can close its database cleanly.
CMD ["node", "--import", "tsx", "packages/host/src/index.ts"]
