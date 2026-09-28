# 5 · Developer guide

← [4 · Troubleshooting](4-troubleshooting.md) · [Back to README](../README.md)

This page is for anyone who wants to change or extend the bot. You don't need it just to run the bot.

- [Tech stack](#tech-stack)
- [Code map](#code-map)
- [How it fits together](#how-it-fits-together)
- [Data format](#data-format)
- [Scripts & tests](#scripts--tests)

---

## Tech stack

- **Node.js 20+** with **discord.js 14**. Every message uses Discord **Components V2** (containers, sections, media galleries, file cards).
- **@napi-rs/canvas** draws the welcome banner, using the fonts bundled in `assets/fonts/` (no system fonts needed).
- **dotenv** loads `.env`. **mongodb** is used only when `MONGODB_URI` is set.
- Intents: Guilds, Guild Members (privileged), Guild Messages, Guild Message Reactions, Guild Expressions. **No Message Content intent.**

## Code map

```
src/
├── index.js              Starts the client, registers slash commands per server, wires events, health check
├── config.js             Reads environment variables (token, storage, branding colours)
├── commands.js           Definitions of all slash commands + right-click (message) apps
├── interactions.js       Routes buttons/menus/forms by custom-ID prefix, autocomplete, friendly error messages
├── features/
│   ├── buttonRoles.js    Button-role panels, the “My roles” manager, /buttonroles
│   ├── reactionRoles.js  Reaction-role panels, reaction events, /reactionroles
│   ├── announcements.js  Composer, private preview, publish/edit, right-click apps, /announce
│   ├── welcome.js        Welcome messages, auto-role, /welcome
│   └── help.js           /help card
└── lib/
    ├── store.js          Storage: JSON file (atomic writes + .bak) or MongoDB
    ├── ui.js             Components V2 helpers (cards, notices, replies, command mentions)
    ├── card.js           Welcome banner renderer (1200×480 PNG)
    ├── utils.js          Parsing, emoji handling, permission checks, file downloads
    ├── color.js          Colour names (purple, gold…) → hex
    └── log.js            Timestamped console logging
tests/
├── selftest.js           77 checks of every message/form against Discord's layout limits
├── flowtest.js           29 end-to-end flows through the real handlers on a mock Discord server
└── helpers/validate.js   Payload validator shared by the tests and the preview tool
tools/
└── preview-html.js       Rebuilds docs/previews/ from the bot's real message payloads
assets/fonts/             Poppins + Noto Sans (SIL Open Font License)
```

## How it fits together

| Discord event | Handled by |
|---|---|
| Ready / bot joins a server | `index.js` registers the commands for that server (they appear instantly) |
| Slash command, button, menu, form, autocomplete | `interactions.js` → the matching feature file |
| Member joins / finishes Membership Screening | `welcome.js` (welcome message, auto-role) |
| Reaction added / removed | `reactionRoles.js` |
| Message deleted, role deleted | Each feature updates its saved records (button-role panels are kept, so they can be reposted) |

Custom IDs on buttons, menus and forms start with a prefix that tells `interactions.js` where to send them:

| Prefix | Feature |
|---|---|
| `br:` | Button roles (panel buttons, “My roles” manager, create/edit forms) |
| `rr:` | Reaction roles (create form) |
| `an:` | Announcements (composer, preview buttons, edit form) |
| `wl:` | Welcome (message form) |

## Data format

One record per server:

```js
{
  welcome:       { enabled, channelId, title, message, imageSubtitle, image, background, color, ping, rulesChannelId, rolesChannelId, autoRoleId },
  reactionRoles: { [messageId]: { channelId, mode, panel?, entries: [...] } },
  buttonPanels:  { [panelId]:   { ...panel settings and roles } },
  announcements: { [firstMessageId]: { ...record used by “Edit Announcement” } },
}
```

## Scripts & tests

| Command | What it does |
|---|---|
| `npm start` | Run the bot (needs `DISCORD_TOKEN`) |
| `npm test` | Self-test + end-to-end flows. Offline: no token or Discord connection needed |
| `npm run preview` | Rebuild `docs/previews/ui-preview.html` and `docs/previews/welcome-card.png` |

Run `npm test` after every change. It catches layouts that Discord would reject (too many components, text over 4,000 characters, bad custom IDs …) before you deploy.

---

← [4 · Troubleshooting](4-troubleshooting.md) · [Back to README](../README.md)
