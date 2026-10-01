# 2 · Using the bot

← [1 · Setup guide](1-setup-guide.md) · [Back to README](../README.md) · Next: [3 · Hosting & settings](3-hosting-and-settings.md) →

Type `/help` in Discord for a clickable overview. Every feature is explained below:

- [🎛️ Button roles](#️-button-roles)
- [😀 Reaction roles](#-reaction-roles)
- [✨ Auto reactions](#-auto-reactions) · [📋 Emoji templates & copying](#-emoji-templates--copying)
- [😀 React to any message](#-react-to-any-message)
- [📢 Announcements](#-announcements)
- [👋 Welcome](#-welcome)
- [🗂️ Server IDs](#️-server-ids)

👉 To see what each panel and message looks like, open [`previews/ui-preview.html`](previews/ui-preview.html) in your browser.

---

## 🎛️ Button roles

```
/buttonroles create channel:#get-roles style:List mode:Toggle color:purple banner:<image>
```
A form opens: enter a **title**, **description**, **pick up to 25 roles** and an optional footer. The panel is posted immediately. Then polish each role:
```
/buttonroles add panel:🎮 Pick your games role:@Valorant emoji:🎯 label:Valorant description:Pings for brackets & scrims button_color:Blurple
```
(Running `add` again for the same role **updates** it. Type `none` for emoji/description to clear them.)

| Style | Looks like | Max roles |
|---|---|---|
| **List** | A card row per role (emoji, name, description) with a **Get** button | 9 |
| **Button grid** | Compact emoji buttons, 5 per row | 20 |
| **Dropdown** | Role overview + **Choose roles** → personal menu pre-filled with the member's roles | 25 |

Panels that outgrow a style automatically switch to the next one.

| Mode | Behaviour |
|---|---|
| **Toggle** | Click to get, click again to remove |
| **One at a time** | Picking a role swaps out the member's other role from that panel (divisions, teams, colours) |
| **Add-only** | Members can claim but not remove roles |

Every panel has a **👤 My roles** button, a private live view of the member's roles with Add/Remove buttons. All confirmations are private (ephemeral), so the channel stays clean.

More commands:

| Command | What it does |
|---|---|
| `/buttonroles edit` | Pick only the panel to edit its text in a form, or change style / mode / colour / `banner` (`remove_banner:True` removes it) |
| `/buttonroles remove` | Remove a role from a panel |
| `/buttonroles repost` | Post a panel again, after an accidental deletion or to move it (`channel:`) |
| `/buttonroles delete` | Delete a panel and its message |
| `/buttonroles list` | Show all panels, with a link to each one |

**Safety built in:** roles with dangerous permissions (Administrator, Manage Server, Ban, etc.) can't be put on panels, and staff can't add roles above their own highest role.

## 😀 Reaction roles

```
/reactionroles create channel:#get-roles mode:Normal        → posts a panel (form: title + description)
/reactionroles add message:<pick from list> emoji:🔴 role:@Red Team description:Team captain: Nova
```
- To use **any existing message**, right-click it → **Copy Message Link** and paste the link into `message:`.
- The bot adds the reaction itself and bot panels update their role list automatically.
- `/reactionroles mode`: **Normal** (unreact removes) · **One at a time** (only one role per message) · **Verify** (reacting gives the role permanently; great for rules).
- `/reactionroles remove`, `clear`, `list`.

## ✨ Auto reactions

```
/autoreact set channel:#clips                          → opens a list of your server's emojis: tick them, then Save
/autoreact set channel:#clips emojis::gg: :hype: 🔥     → or type them (this replaces the channel's list)
/autoreact add channel:#clips emojis::kekw:            → add more (up to 20 per channel)
/autoreact remove channel:#clips emoji::hype:          → take one off (leave emoji: empty to turn the channel off)
/autoreact list                                        → every channel and its emojis
```
- **Easiest:** leave `emojis` empty and tick your emojis in the list (see [😀 the emoji list](#the-emoji-list) below). Animated emojis work without Nitro. Typing also works: server emoji names (`:gg:`) and normal emojis.
- **Every new message** gets the reactions: from members, other bots and webhooks, and the bot's own announcements and welcome messages. Add `bots:False` to `set` to react to members' messages only.
- A split announcement only gets them on its **last part**, so it still reads as one post. The bot's role panels are left alone, so their reactions keep their meaning.
- **Forum and media channels:** the first message of every new post gets the reactions (great for 👍 👎 on suggestions). Replies inside a post don't.
- Only new messages get reactions. Messages that are already there aren't touched.
- The bot needs **View Channel**, **Read Message History** and **Add Reactions** in that channel (checked when you run `set`). Discord adds about 4 reactions a second per channel, so a long list takes a moment on each message.
- Delete one of the emojis from the server and the bot takes it off every list by itself.

### 📋 Emoji templates & copying

Set your emojis up once, then put them on as many channels as you like.

```
/autoreact copy from:#clips                            → copy #clips' emojis to other channels: pick them, then Apply
/autoreact template create name:Hype                   → new template: tick its emojis in the list, then Save
/autoreact template create name:Hype from:#clips       → or make it from a channel's emojis (#clips then uses it too)
/autoreact template apply name:Hype                    → put it on many channels at once
/autoreact template edit name:Hype                     → change its emojis: every channel using it updates
/autoreact template delete name:Hype                   → delete it (its channels keep their emojis)
/autoreact template list                               → your templates, where they're used, and menus to apply or edit them
```
- **Picking the channels:** a private card with two menus and a button. Pick up to 25 channels one by one, pick **whole categories** (all their chat channels), or press **🌐 All chat channels**. The card shows exactly which channels you picked before you press **✅ Apply**.
- **Copy** is a one-time copy of a channel's emojis (and its `bots` setting). **A template stays linked:** edit it once and all its channels change together.
- Change one of a template's channels on its own (`/autoreact set` · `add` · `remove`) and that channel gets its own list. Meant to change all of them? Press **📋 Update template … to this instead** on that confirmation.
- Channels where the bot can't react (it's missing **Add Reactions**, for example) are skipped and named on the card, so you can fix their permissions and apply again.
- **All chat channels** means the text, announcement, forum and media channels the bot can see. Voice-channel chats and threads are only added when you pick them one by one.
- Up to 25 templates per server, 20 emojis each. `/autoreact list` shows the channels of each template together.

## 😀 React to any message

```
/react message:1288976543210987654                     → finds the message in any channel and opens the emoji list
/react message:<message link>                          → same, with a link (right-click → Copy Message Link)
/react message:1288976543210987654 emojis::gg: 🔥       → reacts straight away, no list
```
- Or skip the ID: right-click the message → **Apps → React as Bot**.
- **Copy Message ID** appears when Developer Mode is on (User Settings → Advanced → Developer Mode). With just an ID, the bot looks in the current channel first, then every channel and thread it can read. Pick `channel:` to tell it where to look.
- The list starts with the bot's current reactions on that message ticked. Untick one to take the bot's reaction off. Other people's reactions are never touched.

### The emoji list

Used by `/react`, **React as Bot**, `/autoreact set` (with the emojis box empty) and `/autoreact template create` · `edit`. Only you see it.
- Your server's emojis, **animated ones too**, A→Z in dropdowns of 25 (100 per page). Open a dropdown and tick as many as you like. They're added in the order you tick them, up to 20.
- **◀️ / ▶️** change page, **🔍 Search** finds emojis by name, **⌨️ Type** adds normal emojis (🔥 👍), **🗑️ Clear** starts over.
- **✅ React** / **✅ Save** applies your choice; **Cancel** changes nothing. A list stays usable for 30 minutes.
- Emojis the bot can't use are hidden: emojis limited to roles the bot doesn't have, and emojis disabled after a lost boost level.

## 📢 Announcements

```
/announce channel:#announcements ping:@everyone style:Card color:gold images:Top crosspost:True
```
A composer opens with **Title**, **Message** (4,000 chars), **More text** (another 4,000), **Attachments** (up to 10 files) and **Footer**. You get a **private preview** with:

`🚀 Publish` · `✏️ Edit` · `🎨 Plain/Card style` · `Discard`

- Images and videos appear as a gallery (top or bottom); other files (PDF, ZIP…) as downloadable file cards. Name a file `SPOILER_...` to blur it.
- Long posts are split into several messages automatically (Discord allows 4,000 characters per message). Where it can, the bot splits right before a heading, and it never leaves an intro line such as “The following are prohibited:” at the end of a part. The parts read as **one post**: the bot’s name appears only once, above part 1.
- Parts 2+ mention the same people in a small **“↳ Part 2 of 3 · @everyone”** line, so the whole announcement is highlighted the same way, but members are **notified only once**: parts 2+ arrive with the ping switched off, then the bot switches it on with a quick edit (edits never notify anyone). Because of that edit, Discord shows a small grey **(edited)** under parts 2+. Prefer a different look, or a notification for every part? See `EXTRA_PING_STYLE` and `EXTRA_PING_NOTIFY` in [Hosting & settings](3-hosting-and-settings.md#settings-environment-variables).
- Markdown works: headings, **bold**, lists, links, `<#channel>` and `<@&role>` mentions. Only the ping you chose notifies people.
- `crosspost` publishes to servers following your announcement channel.
- Previews stay open for 30 minutes. Publish before then, or before the bot restarts.

**Right-click Apps (on any message → Apps):**
- **Post as Announcement** turns a draft message (with its attachments) into an official post. Write your draft normally in a staff channel, with emoji and mention autocomplete, then pick the channel and ping in the form.
- **Edit Announcement** edits a bot announcement later (text and optionally replace attachments). Right-click **any** part of it. Edits never ping anyone again, and every part keeps its ping highlight. If the text grows, the extra part is added at the end of the channel (highlighted too, nobody is pinged). If someone deleted the first part, the announcement simply continues from its next part.
  - Announcements posted by an older version of the bot may show the bot’s name again above part 2 (with a 🔕 bell). Discord can’t change that on a posted message, so after you submit an edit on one, the bot offers **🔁 Repost**: a fresh copy that reads as one post goes to the bottom of the channel, the old one is removed, and nobody is pinged.

## 👋 Welcome

```
/welcome setup channel:#welcome image:True ping:True color:violet
```
You'll get an instant preview. Then customise:

| Command | What it does |
|---|---|
| `/welcome message` | Form for title, message and the banner subtitle |
| `/welcome image enabled:True/False` | **Switch between image banner and text card** · add `background:<image>` for a custom background (1200×480 fits best) · `reset_background:True` |
| `/welcome buttons rules_channel:#rules roles_channel:#get-roles` | Link buttons under the welcome (leave empty to remove) |
| `/welcome autorole role:@Member` | Give every new member a role (waits for Membership Screening if enabled) |
| `/welcome toggle enabled:False` | Pause/resume |
| `/welcome test public:False` | Preview with yourself |
| `/welcome settings` | Show everything |

**Placeholders** for title/message/subtitle: `{user}` (mention) · `{name}` (display name) · `{username}` · `{server}` · `{members}` (e.g. 1,284) · `{members_ordinal}` (e.g. 1,284th). Bots are never welcomed.

## 🗂️ Server IDs

```
/ids
```

Shows the whole server at a glance, **only to you**:

- **Every category with its channels** in the same order as your sidebar, then **every role** (highest first), each with its **ID**. The server ID is at the top.
- Channel icons: `#` text · 📢 announcement · 🔊 voice · 🎙️ stage · 💬 forum · 🖼️ media. **🔒** means private (hidden from @everyone).
- Role marks: 🤖 bot or integration role · 🛡️ has Administrator.
- Big servers are split into pages: use **◀️ Previous / Next ▶️**, or jump straight to **📁 Channels** or **🎭 Roles**.
- The attached **`.txt` file** always has the complete list, which is handy for copying IDs.
- Threads aren't listed. Staff only by default (Manage Server); change who can use it in Server Settings → Integrations → the bot.

---

← [1 · Setup guide](1-setup-guide.md) · [Back to README](../README.md) · Next: [3 · Hosting & settings](3-hosting-and-settings.md) →
