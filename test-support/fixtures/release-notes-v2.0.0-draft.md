# AIOManager v2.0.0

The platform release. 1.8.5 managed Stremio accounts. 2.0.0 manages your
entire setup: Stremio, Nuvio, RealStream, and Hydra as first-class connections,
unlimited accounts, a rebuilt sync engine with end-to-end encrypted cloud
sync, an autonomous failover engine, a full metrics suite, a saved addon
library with profiles and tags, built-in docs, and a recommendation system.
Self-hosted on your own hardware, with health probes, PostgreSQL support for
scale, and proper security hardening.

This was a rebuild, not an update, so here's the short list of what's new:

- Multi-platform connections: Nuvio, RealStream, Hydra, and Stremio, kept in
  sync by a bidirectional reconciler
- A rebuilt sync engine with end-to-end encrypted multi-device sync
- Remember this device + OAuth login for Stremio accounts
- Setups: multiple addon configurations per account
- For You: personalized rails built from your watch history
- Discover: addon and content discovery with preferences
- PMDB publishing
- The Kronorium: built-in searchable docs
- Notes: a markdown workspace with a split view, tags, and search
- Theme editor: full themes without touching CSS
- Per-account metadata keys + a built-in metadata proxy
- Activity and watchlist syncing, with deletion tombstones
- The new server stack: PostgreSQL, health probes, stateless scaling
- Security: SSRF guards, HMAC signing, encryption at rest

There are so many changes here that I lost track over time, and some are
definitely left out of this list. So please explore!!

---

## 🔌 Multi-Platform Connections

Stremio, Nuvio, RealStream, and Hydra are all first-class connections with a
bidirectional reconciler that keeps them in sync: addons, plugins, profiles,
library, collections, and watched state. Self-hosted Nuvio backends are
supported, with delta sync for fast cycles.

Connection failures are no longer silent. Each connection reports its own
state, and deletions propagate to connected platforms instead of quietly
never applying.

One note on out-of-band deletions: removing addons directly on Nuvio (outside
AIOManager) is overridden by your sync state on the next cycle - the sync
record is the source of truth. To delete an addon everywhere, delete it in
AIOManager and let it propagate.

---

## 🔐 Sync, Sign-In & Your Identity

- Encrypted multi-device sync (AES-256-GCM). The server stores only
  ciphertext.
- Remember this device: opt-in saved sign-in with a per-device token.
- OAuth login for Stremio accounts.
- Setups: multiple addon configurations per account, switchable without
  reinstalling.

---

## 🎬 For You, Discover & Search

- For You: personalized rails built from your watch history, grid mode
  included.
- Discover: addon and content discovery with preferences and anime detection.
- PMDB publishing for building and sharing lists.
- Search improvements: keyless fallback to Cinemeta, RPDB poster support.

---

## 📖 The Kronorium

Built-in, searchable documentation for every page and setting. One Ctrl+K
away instead of a Discord question.

---

## 🧩 In-app addon management

AIOMetadata and AIOStreams get their own pages: configure, manage, and sync
both services directly from AIOManager. Metadata keys are managed per account
and metadata requests run through a built-in proxy.

---

## 📝 Notes

A markdown notes workspace with a split view, tags, and search, syncing
across your devices.

---

## 🎨 Theme editor

Build and apply full themes without touching CSS.

---

## 📊 Activity, Watchlist & Metrics

Watched state syncs across platforms, deletions are tombstoned so they
propagate, and the watchlist syncs alongside it. Metrics gained accuracy
fixes, filters, and corrected counts.

---

## 🧰 Under the hood

The Discover store (favorites and preferences), the activity system rebuilt
from the ground up, a shared HTTP client with retries and timeouts on every
request, request deduplication, cache pruning, keyboard shortcuts, and the
command palette.

---

## 🔒 Security

SSRF guards on every server-side outbound request. HMAC signing on proxy
requests. Autopilot rules and Stremio auth keys encrypted at rest. Webhook
endpoint validation.

---

## 🐛 Fixed since 1.8.5

- 304 responses starving sync: skipped hydration, rejected pushes, frozen
  header. Fixed.
- Force push logging success before attempting anything. Fixed.
- Health checks disabling every addon on a single failure. Fixed.
- Watched episode corruption. Fixed.
- Addon names disappearing across syncs (three stacked causes). Fixed.
- Deletion propagation to Nuvio: deletions made in AIOManager now reach
  Nuvio reliably instead of being resurrected on the next sync. Fixed.
- Self-hosted Nuvio backends without the profile-sync RPC: now fall back to
  your primary profile instead of refusing every write. Fixed.
- Session restore, identity preservation, and stale auth header caches
  causing 401s on fresh sessions. Fixed.
- Static serving crashing on every response. Fixed.

---

## ⬆️ Upgrading from 1.8.5

The 2.0 server migrates your 1.8.5 data directory on first boot. Accounts,
addons, vault, notes, and settings are preserved. Sign in with your existing
UUID and password.

The upgrade path was tested directly: a 1.8.5 instance with a registered sync
account was upgraded to 2.0 on the same data directory, and the identity,
login, and data all survived with zero migration errors.

If anything looks off after updating, open Sync status and send the log. It
records the exact reason for every skip, block, and failure, so your report
names the bug instead of describing the symptom.

---

## 💝 Support

AIOManager is and always will be free. If v2.0.0 is worth something to you:

- TorBox referral: https://torbox.app/subscription?referral=a7aecfd0-57c8-48fa-9e49-2904f09d57d2
  (bonus days for both of us on your first purchase)
- GitHub Sponsors: https://github.com/sponsors/sonicx161
- Ko-fi: https://ko-fi.com/sonicx161
- Buy Me a Coffee: https://buymeacoffee.com/sonicx161
- Or just star the repo - it genuinely helps
