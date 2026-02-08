<div align="center">
  <img src="public/logo.png" width="128" alt="AIOManager Logo">
  <h1>AIOManager</h1>
  <p><strong>One Manager to rule them all.</strong></p>
  
  <p align="center">
  AIOManager is the ultimate <strong>account management</strong> toolkit for Stremio. Built for power users who demand full functional and granular control, it allows you to sync multiple identities, backup complex addon configurations, and track your watch history with absolute privacy.
  </p>

  <br />

  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
  [![Vite](https://img.shields.io/badge/Vite-B73BFE?style=flat&logo=vite&logoColor=FFD62E)](https://vitejs.dev/)
  [![React](https://img.shields.io/badge/React-20232A?style=flat&logo=react&logoColor=61DAFB)](https://reactjs.org/)
  [![TailwindCSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=flat&logo=tailwind-css&logoColor=white)](https://tailwindcss.com/)
  [![Support on Ko-fi](https://img.shields.io/badge/Support%20on%20Ko--fi-F16061?style=flat&logo=ko-fi&logoColor=white)](https://ko-fi.com/sonicx161)
  [![GitHub Stars](https://img.shields.io/github/stars/sonicx161/aiomanager?style=social)](https://github.com/sonicx161/aiomanager)

  <br />

  <h3>Dashboard Overview</h3>
  <img src="public/screenshots/accounts.png" width="100%" alt="AIOManager Multi-Account Dashboard">
</div>

---

> [!NOTE]
> **Project Goal & Maintenance Status**
> This project was developed as a personal tool to fill the gap in advanced Stremio account management. It is currently **feature-complete** for my personal needs. While I am happy to share it with the community, I am not looking for feature requests at this time. Pull Requests and bug reports are welcome, but maintenance is done on a best-effort basis.

---

## ⚡ Features

### 🛠️ Total Management
The soul of AIOManager is giving you complete authority over your Stremio ecosystem.
*   **Addon Snapshots**: Save configurations for complex addons like AIOStreams or AIOMetadata to your private library.
*   **Account Sync**: Seamlessly switch between multiple Stremio logins without losing your place.
*   **Bulk Actions**: picking dozens of history items to move, or using **Bulk Install from URLs** to hydrate new accounts instantly.
*   **Account Cloning**: Effortlessly clone one account's setup to another using the **Concatenate** strategy (Safe Copy).
*   **Duplicate Support**: Manage multiple instances of the same addon (e.g., dual Debrid configs) with index-based targeting that prevents overwrites.
*   **Granular Control**: Reorder profiles, customize addon branding, and manage your sidebar exactly how you want it.
*   **Failover Logic**: Automatically switch to backup addons if your primary provider goes offline with real-time health flags.

<div align="center">
  <h4>Granular Addon Control</h4>
  <img src="public/screenshots/addon-grid.png" width="100%" alt="Addon Management">
  <br />
  <h4>Advanced Failover Rules</h4>
  <img src="public/screenshots/failover.png" width="100%" alt="Failover Rules">
  <br />
  <h4>Drag & Drop Reordering</h4>
  <img src="public/screenshots/reorder.png" width="100%" alt="Reorder Addons">
  <br />
  <h4>Custom Addon Customization</h4>
  <img src="public/screenshots/editor.png" width="100%" alt="Addon Editor">
</div>

### 📊 Mega Metrics
*   **Pulse**: Real-time activity tracking, Trending Now clusters, and the **Streak Hall of Fame**.
*   **Deep Dive**: Prime Time heatmaps, Retention Funnels, and "The Graveyard" for abandoned shows.

### 🛡️ Privacy First Sync
*   **Local First**: Your data stays in your browser via IndexedDB.
*   **Encrypted Cloud**: Optional sync using AES-256-GCM encryption. User-side keys never leave your device.
*   **Server-Side Protection**: [New] Autopilot rules and Stremio auth keys are now encrypted at rest on the server using a global `ENCRYPTION_KEY` secret.

---

##  Installation

### Docker (Recommended)
This is the easiest way to run AIOManager on your home server or VPS.
1. Download the `docker-compose.yml` and create a `.env` file from the example.
2. Run the following command:
```bash
docker compose pull && docker compose up -d
```

### Unraid Support 🛠️
AIOManager is now optimized for **Unraid**! You can find the template in the [unraid-template.xml](unraid-template.xml) file or simply add it via the **Community Applications** (search for AIOManager).

**Key Unraid Features:**
- **Persistent AppData**: Standardized `/mnt/user/appdata/aiomanager` mapping.
- **Auto-Update**: Compatible with Unraid's Docker update system.
- **Port Flexibility**: Default port `1610` can be easily remapped in the template.

---

## 🏁 Getting Started

Once the app is running:
1. Open the app in your browser (usually `http://localhost:5173` or your server IP).
2. You will be greeted by the **Login** screen. Stay on the **New Account** tab to generate your unique **Account UUID**.
3. Choose a strong password. This is the **only key** to your encrypted data.
4. Once inside, use the **Accounts** page to link your Stremio identities. You can then go to **Settings** to customize your name for AIOManager or enable Auto-Save. (Note you still need to use your UUID to login) 

<div align="center">
  <h4>Initial Setup & Login</h4>
  <img src="public/screenshots/login.png" width="100%" alt="Login Screen">
</div>

---

## 🛡️ Security & Zero-Config Encryption

AIOManager is designed to be **secure by default**, even in public instances with many users.

### Server-Side Data Protection
Sensitive Autopilot rules (including Stremio auth keys) are encrypted at rest on the server using AES-256-GCM.

### Zero-Config Security
You don't need to manually configure encryption for it to work:
1. **Automatic Generation**: If `ENCRYPTION_KEY` is not provided in your `.env`, the server automatically generates a secure random 32-byte key on first boot.
2. **Persistent Storage**: This key is saved to your `DATA_DIR/server_secret.key`.
3. **Multi-Key Fallback (Anti-Lockout)**: If you later decide to set a manual `ENCRYPTION_KEY`, the server will use your new key for *new* data, but will automatically use the old `server_secret.key` as a fallback. This ensures that existing users are never locked out of their data if you change the server configuration.

### Secure Context (HTTPS) Required

> [!IMPORTANT]
> AIOManager **must** be served over a **Secure Context** (HTTPS or Localhost). Browser security policies block the necessary encryption APIs on insecure remote connections.

#### Option 1: The Proper Way (Recommended)
*   **Localhost**: Works over `http://localhost:5173`.
*   **Remote/Server**: **HTTPS is Mandatory** (via reverse proxy like Traefik, Caddy, or Nginx Proxy Manager).
*   **Plain HTTP over IP**: Accessing via `http://192.168.x.x` **will not work**.

#### Option 2: Browser Bypass (Advanced / Chrome & Edge)
If you cannot set up a reverse proxy, you can force your browser to treat your server's IP as secure:
1. Open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
2. Add your server's address: `http://192.168.x.x:8080` (replace with your IP/Port)
3. Change the dropdown to **Enabled**
4. Relaunch your browser.

---

## 🚀 High Availability & Multi-Tenant (K8s/Clustered)

AIOManager is designed for high-scale environments like **Kubernetes** clusters or larger multi-tenant deployments.

### PostgreSQL Support (Recommended for Scale)
For deployments with many users, switch from SQLite to **PostgreSQL** to unlock horizontal scaling and better concurrency:
- Set `DB_TYPE=postgres`
- Provide `DATABASE_URL=postgres://user:pass@host:5432/dbname`

### Health & Readiness Probes
The server includes a dedicated health endpoint for orchestrators:
- **Endpoint**: `/api/health`
- **Behavior**: Returns `200 OK` (ok) or `503 Service Unavailable` (degraded) if the database connection is lost. Use this for your K8s Liveness and Readiness probes.

### Stateless Scaling
With PostgreSQL enabled and `DATA_DIR` mapped to a persistent volume (for `server_secret.key`), the API instances are stateless and can be scaled horizontally behind a load balancer.

---

## [1.5.9] - Pulse Dashboard & Sync Hardening ⚡
AIOManager v1.5.9 is a major release combining specific highly-requested stability fixes with a complete dashboard transformation.

### 🚨 Critical Fixes
- **Sync Hardening**: Resolved "Rule Battles" and account duplication with a new Live Base sync model.
- **Failover Fixes**: Fixed the "???" missing metadata bug by preserving disabled addons in memory.
- **Hybrid Reordering**: Lag-free dragging with vertical locking and hybrid touch/mouse sensors.

### 📊 Dashboard Refinements
- **Pulse-First**: Reprioritized the default view to focus on high-level stats and 24h activity heatmaps.
- **Personality DNA**: Enhanced with "Watch Personas" (Night Owl, Binge Master) and habit tracking.
- **Deep Dive**: Expanded with "The Loop" (rewatch tracking) and "Endurance Test" (completion funnels).

## [1.5.8] - Hybrid Reordering & Critical Sync Fix 💨
AIOManager v1.5.8 introduced a hybrid reordering system for better device support and resolved critical account duplication issues.

### 🛡️ Critical Fixes
- **Account Reconciliation**: Implemented a multi-layered matching strategy (ID, AuthKey, and Email) to correctly identify existing accounts during cloud sync.
- **Hybrid Input Handling**: Differentiates between PC (Mouse) and Mobile (Touch) inputs for an instant feel on desktop.

AIOManager v1.5.6 addresses critical issues with the "Install from Library" functionality, ensuring reliability and flexibility for users with multiple addon configurations.

### 🛡️ Critical Fixes
- **Sync Wipe Prevention**: Fixed a critical bug where corrupted remote data (or `[object Object]` strings) could wipe local accounts on login.
- **Timestamp Conflict Resolution**: Implemented smart merging logic to prevent stale cloud data (from other devices) from overwriting newer local changes.
    - *Logic:* `if (remote.syncedAt < local.lastSyncedAt) -> Merge (Preserve Local)`. `if (remote > local) -> Mirror (Trust Cloud)`.
    - *Fix:* Explicitly triggers a cloud push after a Safe Merge to ensure mobile/remote devices get the recovered state.
- **Cross-Device Mirroring**: Switched to a "Mirror Mode" sync strategy, ensuring that deleted addons/accounts are properly removed across all devices.
- **Auth Race Condition**: Fixed "Database is locked" errors on refresh by implementing a smart lock-check during startup.
- **Mobile FAQ**: Fixed code block overflow on small screens by enabling text wrapping and break-all.

## [1.5.3] - The Resilience Release 🛡️

AIOManager v1.5.3 is an **important bug fix** release resolving critical sync issues.

> [!IMPORTANT]
> **Retroactive Fix**: If you were facing a `[object Object]` or `Invalid library format` error after signing out, you do **not** need to recreate your account. Simply update to v1.5.3 and log in again—the fix automatically repairs the corrupted state.

- **🛡️ Sync Resilience**: Fixed a race condition where the library importer would crash when receiving unexpected objects from the cloud.
- **🔄 Registration Parity**: Ensured fresh accounts are initialized with a standard empty library structure.
- **✨ Robust Parsing**: Hardened all store importers to handle both JSON strings and plain objects gracefully.

## [1.5.2] - The Stabilization Sweep 🛡️

AIOManager v1.5.2 is a maintenance release focused on **reliability, hardening, and UI synchronization**.

### 🛠️ Key Improvements
- **Version Detection Fix**: Resolved a bug where multiple addons on the same domain (like AIOMetadata) would misreport version updates due to cache collisions.
- **Autonomous Stabilization**: Hardened the Autopilot engine to trust the remote Stremio state as the definitive source of truth for addon enablement.
- **Failover Hardening**: Squashed "priorityChain is not iterable" crashes during account cloning and implemented defensive array defaults.
- **Silent Health Checks**: Standardized the "Silent Domain-Only" health check across both Autopilot and Saved Addons to prevent provider flood logs.
- **URL Normalization**: Unified robust URL normalization logic to handle `stremio://` protocols and trailing slashes consistently across the stack.
- **Postgres Support**: Fixed `JSONB` column strictness by converting to `TEXT` for encrypted string support.

## [1.5.0] - The Sovereign Update 🚀

AIOManager v1.5.x is a milestone series focused on **infrastructure independence** and **autonomous reliability**.

---

## ⚖️ Disclaimer

AIOManager is not affiliated with Stremio. It is a secondary management tool developed by the community. All data is processed locally or through your own private sync keys.

---

## ⭐ Star History

<a href="https://star-history.com/#sonicx161/aiomanager&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=sonicx161/aiomanager&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=sonicx161/aiomanager&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=sonicx161/aiomanager&type=Date" />
 </picture>
</a>

---

<div align="center">
  <h3>🤝 Credits & Acknowledgements</h3>
  
  AIOManager is a fork and major evolution of the original <b>Stremio Account Manager</b> by <b>Asymons</b>.  
  Without the foundational work of the following projects and individuals, this would not exist:

  <b>[pancake3000](https://github.com/pancake3000/stremio-addon-manager)</b> (The Original Creator)  
  <b>[Asymons](https://github.com/Asymons/stremio-account-manager)</b> | <b>[Stremio](https://stremio.com)</b> | <b>[Syncio](https://github.com/iamneur0/syncio)</b> | <b>[CineBye](https://cinebye.dinsden.top/)</b>  

  <br />

  Special thanks to the community inspirations who made this journey possible:  
  <b>redd-raven</b>, <b>Viren070</b>, <b>0xConstant1</b>, <b>Sleeyax</b> & <b>&lt;Code/&gt;</b>.

  <br />

  *Built with ❤️ for the Stremio Community.*
</div>
