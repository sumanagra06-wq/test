# 1 · Setup guide

← [Back to README](../README.md) · Next: [2 · Using the bot](2-using-the-bot.md) →

Four steps get the bot from this folder to running 24/7 in your server:

1. [Create the bot in Discord](#1-create-the-bot-in-discord)
2. [Put the code on GitHub](#2-put-the-code-on-github)
3. [Deploy on Railway](#3-deploy-on-railway)
4. [Invite the bot & fix the role order](#4-invite-the-bot--fix-the-role-order)

Using another host, or running it on your PC? See [3 · Hosting & settings](3-hosting-and-settings.md).

---

## 1. Create the bot in Discord

1. Go to **https://discord.com/developers/applications** → **New Application** → name it `AetherBrackets` → **Create**.
2. Open the **Bot** tab:
   - Set the bot's **icon** and **username**. Announcements are posted under this name and avatar, so use your branding.
   - Click **Reset Token** → **copy the token** and keep it secret. This is your `DISCORD_TOKEN`.
   - Under **Privileged Gateway Intents**, turn **ON → Server Members Intent** (needed for welcomes and auto-roles) → **Save Changes**.
   - *Message Content Intent is **not** needed.*
3. *(Optional)* To stop other people inviting your bot, go to **Installation** → set **Install Link** to **None**, then **Bot** → turn **Public Bot** off.
4. From **General Information**, copy the **Application ID**. You'll need it for the invite link.

## 2. Put the code on GitHub

Railway deploys straight from a GitHub repository.

**Easiest (website):**
1. Unzip the download.
2. On github.com, create a new **private** repository → click **uploading an existing file**.
3. Open the `aetherbrackets-bot` folder, select **everything inside it** and drag it onto the page. The folders (`src`, `docs`, `assets` …) keep their structure.
4. Click **Commit changes**.

> On a Mac, press **⌘ Shift .** in Finder to show hidden files, so `.gitignore`, `.dockerignore` and `.env.example` are uploaded too.

**With git:**
```bash
cd aetherbrackets-bot
git init && git add . && git commit -m "AetherBrackets bot"
git branch -M main
git remote add origin https://github.com/<you>/aetherbrackets-bot.git
git push -u origin main
```
> Never commit your token. `.env` is git-ignored; on Railway you add the token as a variable.

## 3. Deploy on Railway

1. Sign in at **https://railway.com** with GitHub → **New Project** → **Deploy from GitHub repo** → pick `aetherbrackets-bot`. Railway finds the included `Dockerfile` and builds it automatically.
2. Open the service → **Variables** → **New Variable** → name `DISCORD_TOKEN`, value = your token → apply/deploy.
3. **Add a Volume so your settings survive redeploys:** on the project canvas, right-click (or press ⌘K / Ctrl+K) → **Volume** → attach it to the bot service → mount path **`/data`**.
   The bot detects Railway volumes automatically (`RAILWAY_VOLUME_MOUNT_PATH`), so nothing else needs configuring.
   *Prefer a database instead? Set `MONGODB_URI` (e.g. a free MongoDB Atlas cluster) and skip the volume.*
4. Open **Deployments → View logs**. You should see:
   ```
   Storage: JSON file in /data
   Logged in as AetherBrackets#1234 — in 0 server(s)
   Invite link: https://discord.com/oauth2/authorize?...
   ```
5. Done. The bot doesn't need a public domain or port. Leave **Serverless / app sleeping** off. Every push to GitHub redeploys automatically.

> Railway is a paid platform after its trial. Check their current pricing; a single-server bot like this uses very little CPU and memory.

## 4. Invite the bot & fix the role order

**Invite:** open the **Invite link** from the logs, or build it yourself (replace `APP_ID`):
```
https://discord.com/oauth2/authorize?client_id=APP_ID&permissions=275146861632&scope=bot+applications.commands
```
The link grants: View Channels, Send Messages (+ in threads), Embed Links, Attach Files, Read Message History, Add Reactions, Use External Emoji, **Manage Roles**, **Manage Messages** and **Mention @everyone**. Slash commands appear instantly in every server the bot joins.

**Role order (important):** in **Server Settings → Roles**, drag the bot's role **above** every role it should hand out (game roles, auto-role…). A bot can only give roles that sit below its own highest role.

**Who can use the commands:** by default `/announce`, `/welcome` and the right-click Apps need **Manage Server**, and `/buttonroles` + `/reactionroles` need **Manage Roles**. To let e.g. a `Staff` role announce, go to **Server Settings → Integrations → AetherBrackets** and add a role override for that command. `/help` is visible to everyone.

✅ **That's it.** Type `/help` in your server to get started.

---

← [Back to README](../README.md) · Next: [2 · Using the bot](2-using-the-bot.md) →
