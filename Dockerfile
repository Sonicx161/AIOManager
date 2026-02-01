# Stage 1: Build Dependencies
FROM node:20-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Production Dependencies Cleanup
FROM node:20-alpine AS production-deps
RUN apk add --no-cache python3 make g++
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
