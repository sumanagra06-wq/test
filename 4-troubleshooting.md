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
| Settings disappear after a redeploy | Attach a Railway Volume ([Setup guide, step 3](1-setup-guide.md#3-deploy-on-railway)) or set `MONGODB_URI` |
| Announcement files missing | The bot needs **Attach Files** in that channel; files must fit your server's upload limit |
| **Draft expired** on an announcement preview | Previews last 30 minutes and are cleared when the bot restarts. Run `/announce` again |
| A button-role panel message was deleted | `/buttonroles repost panel:<name>` restores it with all roles. A banner image is lost with the deleted message, so add it again with `/buttonroles edit panel:<name> banner:<image>` |

Still stuck? Run `/help` in Discord, or check [2 · Using the bot](2-using-the-bot.md) for the exact command options.

---

← [3 · Hosting & settings](3-hosting-and-settings.md) · [Back to README](../README.md) · Next: [5 · Developer guide](5-developer-guide.md) →
