# 3 · Hosting & settings

← [2 · Using the bot](2-using-the-bot.md) · [Back to README](../README.md) · Next: [4 · Troubleshooting](4-troubleshooting.md) →

- [Settings (environment variables)](#settings-environment-variables)
- [Where your data is stored](#where-your-data-is-stored)
- [Other hosts](#other-hosts)
- [Running on your PC](#running-on-your-pc)

---

## Settings (environment variables)

On **Railway**, add these under your service → **Variables**. On your PC, copy `.env.example` to `.env` and fill it in.

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | ✅ | Bot token from the Developer Portal |
| `MONGODB_URI` | | MongoDB connection string. If empty, a JSON file is used |
| `MONGODB_DB` | | Database name (default `aetherbrackets`) |
| `DATA_DIR` | | Folder for the JSON file (default: Railway volume if attached, else `./data`) |
| `BRAND_NAME` | | Name shown on announcements (default `AetherBrackets`) |
| `BRAND_COLOR` / `BRAND_COLOR_2` | | Accent colours (default `#7C5CFF` / `#22D3EE`) |
| `STATUS_TEXT` | | “Watching …” status (default `AetherBrackets`) |
| `PORT` | | If set, a tiny health-check server answers on this port (for hosts that require HTTP) |

## Where your data is stored

Button-role panels, reaction roles, welcome settings and announcement records are saved per server. The `Storage: …` line in the logs shows which option is active (`Storage: MongoDB` or `Storage: JSON file in /data`).

| Option | How it works | Survives redeploys? |
|---|---|---|
| **JSON file** (default) | Saved as `aetherbrackets-db.json` (plus a `.bak` backup). The folder is `DATA_DIR` if set, otherwise the attached Railway Volume, otherwise `./data` | ✅ with a Railway Volume or persistent disk · ❌ without one |
| **MongoDB** | Set `MONGODB_URI` (e.g. a free MongoDB Atlas cluster). Data goes into the `guilds` collection of the `MONGODB_DB` database | ✅ on any host |

> Announcement **previews** (not yet published) are kept in memory for 30 minutes only, so a restart or redeploy discards them. Published announcements are saved normally.

## Other hosts

The included `Dockerfile` works on any Docker host (Railway, Koyeb, Fly.io, Northflank, a VPS). Without Docker you just need **Node.js 20+**: `npm ci --omit=dev && npm start`.

- **Render:** create a **Background Worker** (not a Web Service), because free web services can spin down, which disconnects a bot. Use `MONGODB_URI` or a persistent disk for data.
- **Hosts that require an HTTP port:** set `PORT` and the bot answers health checks on it.
- **Any host without a persistent disk:** use `MONGODB_URI`, or your panels/settings reset on every redeploy.

## Running on your PC

Useful for testing. The bot is only online while your PC is on and the window stays open.

1. Install **Node.js 20 or newer** from https://nodejs.org.
2. Open a terminal in the `aetherbrackets-bot` folder and run:
   ```bash
   npm install
   cp .env.example .env        # Windows: copy .env.example .env
   ```
3. Open `.env` in a text editor and paste your token after `DISCORD_TOKEN=`.
4. Start the bot:
   ```bash
   npm start
   ```
   Stop it with **Ctrl + C**.

---

← [2 · Using the bot](2-using-the-bot.md) · [Back to README](../README.md) · Next: [4 · Troubleshooting](4-troubleshooting.md) →
