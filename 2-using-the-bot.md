# 2 · Using the bot

← [1 · Setup guide](1-setup-guide.md) · [Back to README](../README.md) · Next: [3 · Hosting & settings](3-hosting-and-settings.md) →

Type `/help` in Discord for a clickable overview. Every feature is explained below:

- [🎛️ Button roles](#️-button-roles)
- [😀 Reaction roles](#-reaction-roles)
- [📢 Announcements](#-announcements)
- [👋 Welcome](#-welcome)

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

## 📢 Announcements

```
/announce channel:#announcements ping:@everyone style:Card color:gold images:Top crosspost:True
```
A composer opens with **Title**, **Message** (4,000 chars), **More text** (another 4,000), **Attachments** (up to 10 files) and **Footer**. You get a **private preview** with:

`🚀 Publish` · `✏️ Edit` · `🎨 Plain/Card style` · `Discard`

- Images and videos appear as a gallery (top or bottom); other files (PDF, ZIP…) as downloadable file cards. Name a file `SPOILER_...` to blur it.
- Long posts are split into several messages automatically (Discord allows 4,000 characters per message).
- Markdown works: headings, **bold**, lists, links, `<#channel>` and `<@&role>` mentions. Only the ping you chose notifies people.
- `crosspost` publishes to servers following your announcement channel.
- Previews stay open for 30 minutes. Publish before then, or before the bot restarts.

**Right-click Apps (on any message → Apps):**
- **Post as Announcement** turns a draft message (with its attachments) into an official post. Write your draft normally in a staff channel, with emoji and mention autocomplete, then pick the channel and ping in the form.
- **Edit Announcement** edits a bot announcement later (text and optionally replace attachments).

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

---

← [1 · Setup guide](1-setup-guide.md) · [Back to README](../README.md) · Next: [3 · Hosting & settings](3-hosting-and-settings.md) →
