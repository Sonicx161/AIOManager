# Deploying AIOManager v1.5.7

AIOManager v1.5.7 requires a Node.js server to handle **Autopilot**, **Health Checks**, and **Sync**. 

## 1. Docker (Recommended)

Docker is the most robust way to deploy, ensuring all dependencies and environment variables are handled.

### Docker Compose
```yaml
services:
  aiomanager:
    image: ghcr.io/sonicx161/aiomanager:latest
    ports:
      - "1610:1610"
    environment:
      - PORT=1610
      - NODE_ENV=production
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

## 2. Unraid

1. Ensure the **Community Applications** plugin is installed.
2. Search for **AIOManager**.
3. Use the default template or customize the `App Data` path.
4. Click **Apply**.

## 3. Manual Deployment (Node.js)

If running directly on a VPS without Docker:

1. **Clone & Install**:
   ```bash
   git clone https://github.com/sonicx161/AIOManager.git
   cd AIOManager
   npm install
   ```

2. **Configure**:
   Create a `.env` file based on `.env.example`.

3. **Build & Start**:
   ```bash
   npm run build
   npm run server
   ```

## 🔒 Security Requirements

AIOManager **must** be served over **HTTPS** (or localhost) to enable the browser's Crypto APIs. Use a reverse proxy like **Nginx Proxy Manager**, **Caddy**, or **Traefik** to handle SSL termination.
