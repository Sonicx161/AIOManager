<div align="center">
  <img src="public/logo.png" width="128" alt="AIOManager Logo">
  <h1>AIOManager</h1>
  <p><strong>One Manager to rule them all.</strong></p>
  
  <p align="center">
  AIOManager is the ultimate <strong>account management</strong> toolkit for Stremio. Built for power users who demand full functional and granular control, it allows you to sync multiple identities, backup complex addon configurations, and track your watch history with absolute privacy.
  </p>

  <br />

  [![Version](https://img.shields.io/badge/version-1.7.5-blue.svg)](https://github.com/sonicx161/aiomanager/releases)
  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
  [![Vite](https://img.shields.io/badge/Vite-B73BFE?style=flat&logo=vite&logoColor=FFD62E)](https://vitejs.dev/)
  [![TailwindCSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=flat&logo=tailwind-css&logoColor=white)](https://tailwindcss.com/)
  [![Docker Pulls](https://img.shields.io/docker/pulls/sonicx161/aiomanager?style=flat&logo=docker&logoColor=white)](https://hub.docker.com/r/sonicx161/aiomanager)
  [![GitHub Stars](https://img.shields.io/github/stars/sonicx161/aiomanager?style=social)](https://github.com/sonicx161/aiomanager)
  [![Support on Ko-fi](https://img.shields.io/badge/Support%20on%20Ko--fi-F16061?style=flat&logo=ko-fi&logoColor=white)](https://ko-fi.com/sonicx161)

  <br />

  <h3>Dashboard Overview</h3>
  <img src="public/screenshots/accounts.png" width="100%" alt="AIOManager Multi-Account Dashboard">
</div>

---

> [!NOTE]
> **Maintenance Status**
> AIOManager is now in maintenance mode. Active feature development has wrapped up with v1.7.0. Bug reports via GitHub Issues are welcome and PRs from the community are always open. Maintenance is done on a best-effort basis.

---

## ⚡ Features

### 🛠️ Total Management

The soul of AIOManager is giving you complete authority over your Stremio ecosystem.

* **Addon Snapshots**: Save configurations for complex addons like AIOStreams or AIOMetadata to your private library and deploy them anywhere.
* **Deploy from Library**: Select saved addons and push them directly to any of your accounts without leaving the library page.
* **Account Sync**: Seamlessly switch between multiple Stremio logins without losing your place.
* **Bulk Actions**: Install, remove, reinstall, enable, disable, protect, or clone addons across multiple accounts in one operation. Every action shows you a preview of what's about to happen before you execute.
* **Reinstall Selected**: Pick specific addons and reinstall just those across all your selected accounts from their source URLs. No need to touch the rest.
* **Sync Addon Order**: Copy the addon ordering from one account and apply it to all your selected accounts at once.
* **Account Mirroring**: Copy one account's addon setup to any number of target accounts, with the choice to append or fully overwrite.
* **Duplicate Support**: Manage multiple instances of the same addon (e.g., dual Debrid configs) with URL-based targeting that prevents overwrites.
* **Granular Control**: Reorder profiles, customize addon branding, and manage your sidebar exactly how you want it.
* **Failover Logic**: Automatically switch to backup addons if your primary provider goes offline with real-time health flags.

#### Granular Addon Control
![Addon Management](public/screenshots/addon-grid.png)

#### Advanced Failover Rules
![Failover Rules](public/screenshots/failover.png)

#### Drag & Drop Reordering
![Reorder Addons](public/screenshots/reorder.png)

#### Custom Addon Customization
![Addon Editor](public/screenshots/editor.png)

### 📚 Saved Addon Library

* **Profiles**: Organize your saved addons into profiles and deploy entire profiles to accounts in one click.
* **Tags**: Tag addons for quick filtering and use tags as the basis for bulk install and bulk remove operations.
* **Deploy & Remove**: Push or remove selected addons across specific accounts directly from the library.
* **Manifest Updates**: Refresh the name, logo, and version of selected addons from their source URLs while keeping your tags and profile assignments intact.
* **Conflict Resolution**: When saving addons from an account, choose to skip existing entries, update them with merged tags, or create a new copy.

### 📊 Mega Metrics

* **Pulse**: Real-time activity tracking, Trending Now clusters, and the **Streak Hall of Fame**.
* **Deep Dive**: Prime Time heatmaps, Retention Funnels, and "The Graveyard" for abandoned shows.
* **Smart Repair**: If your watch stats look off, the repair tool finds and fixes corrupted duration data without wiping your history.

### 🔐 Account Management

* **OAuth Login**: Add accounts using the official Stremio OAuth flow. No email or password required.
* **Email & Password**: Standard login with auto-registration. If the account doesn't exist it gets created instantly.
* **Auth Key**: Add accounts directly via auth key for advanced setups.

### 🛡️ Privacy First Sync

* **Local First**: Your data stays in your browser via IndexedDB.
* **Encrypted Cloud**: Optional sync using AES-256-GCM encryption. User-side keys never leave your device.
* **Server-Side Protection**: Autopilot rules and Stremio auth keys are encrypted at rest on the server using a global `ENCRYPTION_KEY` secret.

---

##  Installation

### Docker (Recommended)
This is the easiest way to run AIOManager on your home server or VPS.
1. Download the `docker-compose.yml` and create a `.env` file from the example.
2. Run the following command:
```bash
docker compose pull && docker compose up -d
```

### Unraid Support
AIOManager includes a native Unraid template!
1.  Copy the URL of the [unraid-template.xml](https://raw.githubusercontent.com/sonicx161/AIOManager/main/unraid-template.xml) file.
2.  In Unraid, go to **Docker** > **Add Container**.
3.  Paste the URL into the **Template URL** (or might be "Install from URL" via CA plugins).

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
