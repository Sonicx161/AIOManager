# Build Stage
FROM node:20-alpine AS build

# Install build tools for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy source and build
COPY . .
RUN npm run build

# Production Stage
FROM node:20-alpine AS production

# Install build tools again for production install of native modules
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install only production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy build artifacts and server files
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server

# Create standardized data directory
RUN mkdir -p /app/data

# Environment variable for database path
ENV DATA_DIR=/app/data
ENV NODE_ENV=production

# Expose the port (matching server/index.js)
EXPOSE 1610

# Start the application using the backend server
CMD ["node", "server/index.js"]
