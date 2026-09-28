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
3. Open the `aetherbrackets-bot` folder, select **everything inside it** (the folders too) and drag it onto the page.
4. Click **Commit changes**, then check the repository shows the folders `src`, `docs`, `assets`, `tests`, `tools`.

> ⚠️ If all the files end up side by side with no folders (for example `index.js` next to `README.md`), the bot can't start. Drag the **folders** themselves, or use git (below), which always keeps the structure.
>
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

Your Railway project will contain two services: the **bot** (built from your GitHub repository) and a **MongoDB database** where the bot saves panels, reaction roles, welcome settings and announcements.

1. **Create the bot service:** sign in at **https://railway.com** with GitHub → **New Project** → **Deploy from GitHub repo** → pick your repository. If it isn't in the list, click **Configure GitHub App** and give Railway access to it.
   Railway finds the included `Dockerfile` and builds it automatically. *The first start stops with “DISCORD_TOKEN is missing”. That's expected: you add the token in step 3.*
2. **Add the database:** on the project canvas click **+ New** (or press Ctrl+K / ⌘K) → **Database** → **MongoDB**. Railway creates a service named **MongoDB** with its own storage.
3. **Connect the bot:** click the bot service → **Variables** → **Raw Editor**, paste these two lines, put your bot token in the first one → **Update Variables**:
   ```
   DISCORD_TOKEN=paste-your-bot-token-here
   MONGODB_URI=${{MongoDB.MONGO_URL}}
   ```
   Then click **Deploy** to apply the changes.
   - `${{MongoDB.MONGO_URL}}` is a Railway *reference*: Railway fills in the database's private address and password for you, so never type them by hand. If your database service has another name, put that name before the dot.
   - Optional: click **⋮** next to `DISCORD_TOKEN` → **Seal**, so the token can never be shown again in the dashboard.
4. Open the bot service → **Deployments → View logs**. You should see something like:
   ```
   Storage: MongoDB at mongodb.railway.internal:27017 — connecting…
   Storage: MongoDB connected ✓ (database "aetherbrackets", 0 server(s) loaded)
   Logged in as AetherBrackets#1234 — in 0 server(s)
   Invite link: https://discord.com/oauth2/authorize?...
   ```
   On the very first deploy you may see “MongoDB … is not reachable yet” once or twice while the database starts. The bot waits for it automatically.
5. **Done.** Keep these defaults in the bot service's **Settings**:
   - **Serverless** (app sleeping): **off**, because a sleeping bot goes offline in Discord.
   - **Replicas: 1**. Two copies would answer every click twice.
   - No public domain or port is needed.

   Every push to GitHub redeploys the bot automatically. Your settings stay in the database.

> **No database?** Skip step 2 and the `MONGODB_URI` line in step 3, and instead attach a **Volume** to the bot service (right-click the canvas → **Volume** → mount path **`/data`**). The bot then saves to a file on the volume.
>
> Railway is a paid platform after its trial. Check their current pricing; a single-server bot and a small database use very little CPU and memory.

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
