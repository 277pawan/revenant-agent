# syntax=docker/dockerfile:1
# Default API is localhost. Always overridable at runtime:
#   docker run -e REVENANT_API_URL=https://api.example.com ...
# Do not bake production URLs until you publish a staging/prod tag.

ARG REVENANT_API_URL=http://127.0.0.1:8080

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ARG REVENANT_API_URL
ENV REVENANT_API_URL=${REVENANT_API_URL}
ENV NODE_ENV=production
ENV REVENANT_ALLOW_LOCAL_FALLBACK=false

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY src ./src
RUN npm install tsx@4.19.2 --no-save

USER node
CMD ["npx", "tsx", "src/main.ts"]
