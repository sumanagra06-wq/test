# 4 · Troubleshooting

← [3 · Hosting & settings](3-hosting-and-settings.md) · [Back to README](../README.md) · Next: [5 · Developer guide](5-developer-guide.md) →

First step for almost every problem: open **Railway → your service → Deployments → View logs**. The bot writes plain-English messages there.

| Problem | Fix |
|---|---|
| Logs say **“enable Server Members Intent”** | Developer Portal → Bot → Privileged Gateway Intents → Server Members Intent **on** → redeploy |
| Logs say **token is invalid** | Reset the token in the Portal and update `DISCORD_TOKEN` on Railway |
| Logs say **DISCORD_TOKEN is missing** | Add the `DISCORD_TOKEN` variable on Railway (or in `.env` on your PC) — see [Setup guide, step 3](1-setup-guide.md#3-deploy-on-railway) |
| Slash commands don't show | Re-invite with the link from the [Setup guide](1-setup-guide.md#4-invite-the-bot--fix-the-role-order) (it includes `applications.commands`), then restart Discord (Ctrl+R) |
| “My role must be above…” / roles not given | Server Settings → Roles → drag the bot's role above the roles it manages |
| Welcome not posting | Run `/welcome settings`: status must be 🟢 and the bot needs View/Send/Attach Files in that channel |
| Settings disappear after a redeploy | Connect the MongoDB database ([Setup guide, step 3](1-setup-guide.md#3-deploy-on-railway)), or attach a Railway Volume |
| Logs warn **“No database connected … will be LOST on the next deploy”** | The bot has no `MONGODB_URI`. Add the MongoDB database and the `MONGODB_URI=${{MongoDB.MONGO_URL}}` variable ([Setup guide, step 3](1-setup-guide.md#3-deploy-on-railway)) |
| Logs say **“MongoDB … is not reachable yet”** once or twice, then **“connected ✓”** | Normal on a first deploy while the database starts. Nothing to do |
| Logs say **“Database problem: Could not reach MongoDB”** | Check the MongoDB service is running (green) in the **same** Railway project and environment, and that `MONGODB_URI` is exactly `${{MongoDB.MONGO_URL}}` |
| Logs say **“… a Railway reference that was not filled in”** | The name before the dot doesn't match your database service. Use its exact name, e.g. `${{MongoDB.MONGO_URL}}` |
| Logs say **“rejected the username/password”** | The connection string was typed or copied by hand. Replace it with the reference `${{MongoDB.MONGO_URL}}` |
| The bot doesn’t add its reactions in a channel | Check `/autoreact list`. The bot needs **View Channel**, **Read Message History** and **Add Reactions** there (the logs name the channel). With `bots:False`, messages from bots and webhooks are skipped. Emojis limited to certain roles (Server Settings → Emoji) only work if the bot’s role is allowed |
| A channel stopped changing together with its template | It was changed on its own (`/autoreact set` · `add` · `remove`), which gives it its own list. Press **📋 Update template … to this instead** on that confirmation, or put the template back on it with `/autoreact template apply` |
| Some channels were **skipped** when applying a template or copying | The bot is missing **View Channel**, **Read Message History** or **Add Reactions** there (plus **Use External Emoji** for emojis from other servers). Fix that channel's permissions and apply again |
| A channel is missing from **🌐 All chat channels** | That button adds the text, announcement, forum and media channels the bot can **see**. Give the bot's role View Channel there, or pick voice-channel chats and threads one by one in the first menu |
| Auto reactions show up slowly in a busy channel | Discord lets a bot add about 4 reactions a second per channel. Fewer emojis make it faster. If a channel is flooded, the bot skips some messages until it catches up (the logs say so, at most once an hour) |
| `/react` says **Message not found** | Check the ID, or paste the message **link** instead (right-click → **Copy Message Link**). The bot also needs **View Channel** and **Read Message History** in that channel. Messages in archived threads aren’t searched: use the link |
| No **Copy Message ID** in the right-click menu | Turn on Developer Mode: User Settings → Advanced → Developer Mode. Or use **Copy Message Link**, or right-click → **Apps → React as Bot** |
| An emoji is missing from the emoji list | It’s hidden because the bot can’t use it: it’s limited to certain roles (Server Settings → Emoji → the emoji → allow the bot’s role) or it was disabled after the server lost a boost level. Big servers: use **🔍 Search** or the page buttons |
| Announcement files missing | The bot needs **Attach Files** in that channel; files must fit your server's upload limit |
| Logs say **“Discord had a temporary problem (503 …)”** or users saw **“The application did not respond”** | Discord’s own servers had a short outage (5xx errors come from Discord, not the bot). Just try again; check **https://discordstatus.com** if it keeps happening |
| An older announcement has the ping only on its **first** part | Posted before this fix. Right-click it → **Edit Announcement** → **Submit**: parts 2+ get the small ping tag and the highlight, and nobody is pinged again |
| Part 2 of a long announcement shows the bot’s name again (with a 🔕 bell) | It was posted by an older version of the bot, which sent parts 2+ as Discord “silent” messages. Discord always shows the name again above those, and a posted message can’t be changed. Right-click it → **Edit Announcement** → **Submit** → **🔁 Repost**: a fresh copy that reads as one post goes to the bottom of the channel, the old one is removed, and nobody is pinged. New announcements don’t have this problem |
| Parts 2+ of an announcement say **(edited)** | Normal. That edit is how they get the ping highlight without notifying everyone a second time (edits never notify). Prefer one notification per part and no “(edited)”? Set `EXTRA_PING_NOTIFY=every` |
| **Edit Announcement** says the first message had been deleted | Someone deleted part 1. The edit still worked and the announcement now starts at its next part. Attachments that were on the deleted part must be added again |
| **Draft expired** on an announcement preview | Previews last 30 minutes and are cleared when the bot restarts. Run `/announce` again |
| A button-role panel message was deleted | `/buttonroles repost panel:<name>` restores it with all roles. A banner image is lost with the deleted message, so add it again with `/buttonroles edit panel:<name> banner:<image>` |

Still stuck? Run `/help` in Discord, or check [2 · Using the bot](2-using-the-bot.md) for the exact command options.

---

← [3 · Hosting & settings](3-hosting-and-settings.md) · [Back to README](../README.md) · Next: [5 · Developer guide](5-developer-guide.md) →
