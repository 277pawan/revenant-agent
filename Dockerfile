# syntax=docker/dockerfile:1
ARG REVENANT_API_URL=https://api.revenant.cloud
FROM node:22-bookworm-slim
WORKDIR /app
ARG REVENANT_API_URL
ENV REVENANT_API_URL=${REVENANT_API_URL}
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src
RUN npm install tsx@4.19.2 --no-save
USER node
CMD ["npx", "tsx", "src/main.ts"]
