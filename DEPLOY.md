# Deploying AIOManager v4

## 1. GitHub Pages (Recommended)

Since this is a client-side only app (with local storage), it works perfectly on GitHub Pages!

### Step 1: Install `gh-pages`
We have already added the necessary scripts to `package.json`.
If you haven't installed the package yet, run:
```bash
npm install gh-pages --save-dev
```

### Step 2: Configure `vite.config.ts`
Open `vite.config.ts` and ensure the `base` path is set correctly for your repository.
If your repo is `https://github.com/myuser/myrepo`, add:
```typescript
export default defineConfig({
  base: '/myrepo/', // <--- ADD THIS LINE
  plugins: [react()],
  // ...
})
```
*If you are deploying to a custom domain (e.g., `metrics.mydomain.com`), you can skip this or set base to `/`.*

### Step 3: Deploy
Run the deploy command:
```bash
npm run deploy
```
This will:
1. Build the project (`npm run build`)
2. Upload the `dist` folder to the `gh-pages` branch.

### Step 4: Settings
Go to your GitHub Repository -> **Settings** -> **Pages**.
Ensure "Source" is set to `gh-pages` branch.

## 2. Docker / Self-Hosted

You can also serve the static files with any web server (Nginx, Caddy, Apache).

### Dockerfile
Create a `Dockerfile`:
```dockerfile
FROM node:18-alpine as build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

## 3. Vercel / Netlify
1. Connect your GitHub repository.
2. Set Build Command: `npm run build`
3. Set Output Directory: `dist`
4. Deploy!
