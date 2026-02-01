# Stage 1: Build Dependencies
FROM node:20-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Production Dependencies Cleanup
FROM node:20-slim AS production-deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

# Stage 3: Final Distroless Image
FROM gcr.io/distroless/nodejs20-debian12
WORKDIR /app

# Copy production dependencies (including native modules)
COPY --from=production-deps /app/node_modules ./node_modules
# Copy app source
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY package.json ./

# Create data directory (Distroless uses non-root by default usually, but we need to ensure permissions)
# NOTE: In distroless, we can't 'mkdir', so we rely on volume mapping or pre-existing structure
# if we really need it. For now, volume mapping to /app/data is standard.

ENV DATA_DIR=/app/data
ENV NODE_ENV=production
ENV PORT=1610

EXPOSE 1610

# Security: No shell, no root, no distractions.
CMD ["server/index.js"]
