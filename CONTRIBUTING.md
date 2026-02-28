# Contributing to AIOManager

Thank you for even considering this. AIOManager started as something I built strictly for myself and I genuinely didn't expect anyone to find it, let alone want to contribute to it. PRs are welcome and I appreciate anyone willing to put in the time.

Feel free to fork the project and build whatever you want. If I happen to see a PR and want to merge it, cool. If not, no worries! Just know that I am stepping back from active maintenance on this project and won't be actively reviewing issues, feature requests, or large architectural changes. Take the codebase and have fun with it!

---

## How the project is structured

There are two parts to this:

```
/          The frontend (React + Vite + TypeScript)
/server    The sync and Autopilot backend (Node.js + Fastify + SQLite)
```

The frontend is a fully client-side app. The server is optional and only needed if you're working on cloud sync, Autopilot rules, or webhooks. The app works fine without it using local storage only.

---

## Getting it running locally

### What you need

- Node.js v18 or higher
- npm v9 or higher

### Frontend

```bash
npm install
npm run dev
```

That runs on `http://localhost:5173` by default. For a production build it's just `npm run build`.

### Server (only if you need it)

```bash
cd server
npm install
npm run dev
```

You'll need a `.env` file in the `/server` folder. Here's what it supports:

```env
# Encryption key for data at rest. If you leave this blank, a random one gets
# generated and saved to server/data/.secret on the first run. That's fine for local dev.
ENCRYPTION_KEY=

# Port (default is 16100)
PORT=16100

# Where the database and secrets are stored (default is ./data)
DATA_DIR=./data

# Max concurrent proxy requests (default is 50)
PROXY_CONCURRENCY_LIMIT=50
```

In dev, the frontend already proxies `/api` calls to `http://localhost:16100` through Vite. You don't need to configure anything, just run both and they connect.

---

## The stack

| | |
|---|---|
| Frontend | React 18, TypeScript, Vite |
| Styling | Tailwind CSS + shadcn/ui |
| State | Zustand |
| Local storage | localforage (IndexedDB) |
| Backend | Fastify, SQLite via better-sqlite3 |

---

## Submitting a PR

1. Fork the repo and create a branch off `main`
2. Make your changes, keep them focused on one thing
3. Test it manually end to end, there's no automated test suite right now
4. Open a PR against `main` and describe what you changed and why

### Good places to start

- Open bug reports on GitHub
- Edge case handling or error messages that could be clearer
- Mobile and responsive layout issues
- Docs

### A few things to keep in mind

- Keep changes small and targeted. One focused PR is a lot easier to review than a large one touching everything.
- If you're fixing a bug, describe how to reproduce it.
- There's no enforced linter in CI right now but try to match the style of the code around whatever you're touching.
- This is maintained on a best-effort basis so reviews may take some time. I appreciate the patience.

---

## Questions

If something seems like a bug or you want to run an idea by me before writing code, just open a GitHub issue. That's the best place for it.
