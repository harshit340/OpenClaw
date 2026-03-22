# Stage 1: Build client
FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Stage 2: Production
FROM node:20-alpine
WORKDIR /app

COPY server/package*.json ./server/
RUN cd server && npm ci --production

COPY server/ ./server/
COPY config.json.example ./config.json.example
COPY --from=client-build /app/client/dist ./client/dist

# Config can be mounted at runtime
COPY config.json* ./

EXPOSE 8891
ENV PORT=8891

CMD ["node", "server/index.js"]
