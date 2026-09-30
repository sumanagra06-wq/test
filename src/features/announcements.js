'use strict';
const {
  AttachmentBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  FileBuilder,
  FileUploadBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const config = require('../config');
const store = require('../lib/store');
const log = require('../lib/log');
const ui = require('../lib/ui');
const { parseColor, isDefaultColorKeyword } = require('../lib/color');
const autoReact = require('./autoReact');
const { UserError, truncate, chunkText, download, downloadAttachments, assertBotChannelPerms, formatBytes } = require('../lib/utils');

/**
 * Official announcements, posted under the bot's name.
 *  /announce  → compose in a big form (2 × 4000 chars + up to 10 files) → private preview → Publish
 *  Right-click a message → Apps → "Post as Announcement"  (turn any draft, with its files, into an announcement)
 *  Right-click an announcement → Apps → "Edit Announcement"
 *
 * Long posts are split across messages automatically (Discord allows 4000 characters per message).
 */

const SESSION_TTL = 30 * 60 * 1000;
const TEXT_BUDGET = 3500; // per message, leaves room for the preview bar
const MAX_RECORDS = 150;
const CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

/** sessionId → announcement being composed */
const sessions = new Map();
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL;
  for (const [k, s] of sessions) if (s.updatedAt < cutoff) sessions.delete(k);
}, 5 * 60 * 1000).unref();

function newSession(fields) {
  return {
    title: '',
    body: '',
    more: '',
    footer: '',
    style: 'card',
    color: null,
    imagePosition: 'top',
    ping: null,
    crosspost: false,
    files: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...fields,
  };
}

/* ───────────────────────── mentions ───────────────────────── */

function pingText(ping) {
  if (!ping) return null;
  if (ping === 'everyone') return '@everyone';
  if (ping === 'here') return '@here';
  return `<@&${ping}>`;
}

function pingLabel(guild, ping) {
  if (ping === 'everyone' || ping === 'here') return `@${ping}`;
  return `@${guild.roles.cache.get(ping)?.name ?? 'role'}`;
}

function allowedMentionsFor(ping) {
  if (!ping) return { parse: ['users'] };
  if (ping === 'everyone' || ping === 'here') return { parse: ['users', 'everyone'] };
  return { parse: ['users'], roles: [ping] };
}

function resolvePing(guild, input) {
  const v = String(input || '').trim();
  if (!v || /^(none|no|off)$/i.test(v)) return null;
  if (/^@?everyone$/i.test(v)) return 'everyone';
  if (/^@?here$/i.test(v)) return 'here';
  const id = v.match(/^<@&(\d+)>$/)?.[1] ?? v;
  const role = guild.roles.cache.get(id) ?? guild.roles.cache.find((r) => r.name.toLowerCase() === v.replace(/^@/, '').toLowerCase());
  if (!role) throw new UserError('Pick who to ping from the list (@everyone, @here or a role).', 'Unknown ping');
  if (role.id === guild.id) return 'everyone';
  return role.id;
}

/* ───────────────────────── rendering ───────────────────────── */

/**
 * Turns an announcement into one or more message payloads.
 * @returns {Array<{components, files, flags, allowedMentions}>}
 */
function renderAnnouncement(a, options) {
  return renderParts(a, options).map((p) => p.payload);
}

/**
 * Like renderAnnouncement, but each part also says how to post it:
 *   payload — the finished message
 *   quiet   — null, or a version to send first that notifies nobody (no ping switched on, no files).
 *             Sending that and then editing it into `payload` (lightUp) makes the part gold without a
 *             notification: edits never notify. Unlike Discord's "silent" flag, this keeps the part
 *             grouped under part 1 (a silent message after a normal one always gets its own name header).
 * @param {object} [o]
 * @param {'once'|'every'|'none'} [o.notify] who gets notified: once = part 1 only (default, see
 *   EXTRA_PING_NOTIFY) · every = every part · none = nobody (edits and reposts)
 * @returns {Array<{payload: object, quiet: object|null}>}
 */
function renderParts(a, { preview = false, extraPing = EXTRA_PING, notify = EXTRA_NOTIFY } = {}) {
  const body = [a.body, a.more].map((s) => String(s || '').trim()).filter(Boolean).join('\n\n');
  for (let size = 3000; size >= 1000; size -= 250) {
    const parts = buildParts(a, body, size, { preview, extraPing, notify });
    if (parts.every((p) => ui.textLength(p.payload.components) <= TEXT_BUDGET)) return parts;
  }
  return buildParts(a, body, 900, { preview, extraPing, notify });
}

/**
 * How the ping appears on parts 2+ of a long announcement (they are always mentioned, so they stay highlighted):
 *   tag    — a small "↳ Part 2 of 3 · @everyone" line at the top of the part (default)
 *   hidden — the same small line with the ping tucked behind a tiny spoiler
 *   full   — the same ping line above the card as part 1
 * Set with the EXTRA_PING_STYLE environment variable.
 */
const EXTRA_PING = config.extraPingStyle;
/** once (default) | every — see renderParts and EXTRA_PING_NOTIFY in config.js. */
const EXTRA_NOTIFY = config.extraPingNotify;

function buildParts(a, body, chunkSize, { preview, extraPing, notify }) {
  const card = a.style !== 'plain';
  const color = a.color ?? config.brand.color;
  const chunks = body ? chunkText(body, chunkSize) : [''];
  const n = chunks.length;
  const media = a.files.filter((f) => f.kind !== 'file');
  const docs = a.files.filter((f) => f.kind === 'file');
  const mediaPart = a.imagePosition === 'bottom' ? n - 1 : 0;
  const ts = Math.floor((a.publishedAt ?? Date.now()) / 1000);
  const mentionsUsers = /<@!?\d{15,21}>/.test([a.title, body, a.footer].join('\n'));
  const parts = [];

  for (let i = 0; i < n; i++) {
    const blocks = [];
    const files = [];
    const fileBlocks = new Set(); // blocks that show uploaded files (left out of the quiet version)
    const addMedia = () => {
      if (!media.length || i !== mediaPart) return;
      const gallery = ui.gallery(media.slice(0, 10).map((f) => ({ url: `attachment://${f.name}`, spoiler: f.spoiler })));
      blocks.push(gallery);
      fileBlocks.add(gallery);
      files.push(...media.slice(0, 10));
    };

    if (i === 0 && a.imagePosition !== 'bottom') addMedia();
    if (i === 0) {
      const header = [card ? `-# 📢  ${config.brand.name} · Announcement` : null, a.title ? `# ${a.title}` : null].filter(Boolean).join('\n');
      if (header) blocks.push(ui.text(header));
    } else if (a.ping && extraPing !== 'full') {
      const mention = pingText(a.ping);
      blocks.push(ui.text(`-# ↳ Part ${i + 1} of ${n}${extraPing === 'hidden' ? ` ||${mention}||` : ` · ${mention}`}`));
    }
    if (chunks[i]) blocks.push(ui.text(chunks[i]));
    if (i === n - 1) {
      if (a.imagePosition === 'bottom') addMedia();
      for (const f of docs) {
        const fb = new FileBuilder().setURL(`attachment://${f.name}`);
        if (f.spoiler) fb.setSpoiler(true);
        blocks.push(fb);
        fileBlocks.add(fb);
        files.push(f);
      }
      const footer = [a.footer, card ? `<t:${ts}:f>` : null].filter(Boolean).join(' · ');
      if (footer) blocks.push(ui.divider(), ui.text(`-# ${footer}`));
    }
    if (!blocks.length) blocks.push(ui.text('\u200b'));

    const compose = (list) => {
      const components = [];
      // every part mentions the ping target, so a long announcement is highlighted the same way from top to bottom
      if (a.ping && (i === 0 || extraPing === 'full')) components.push(ui.text(pingText(a.ping)));
      if (card) components.push(ui.fillContainer(ui.container(color), list.length ? list : [ui.text('\u200b')]));
      else components.push(...(list.length ? list : [ui.text('\u200b')]));
      return components;
    };

    const payload = {
      components: compose(blocks),
      files: files.map((f) => new AttachmentBuilder(f.buffer, { name: f.name })),
      flags: ui.V2, // never Discord's "silent" flag: it would split the announcement under a second name header
      allowedMentions: preview ? { parse: [] } : allowedMentionsFor(a.ping),
    };

    // parts that must not notify on arrival go out "quiet" first and are then edited into `payload`
    const quietNeeded = !preview && (notify === 'none' ? Boolean(a.ping) || mentionsUsers : notify === 'once' && i > 0 && Boolean(a.ping));
    const quiet = quietNeeded
      ? {
          components: compose(blocks.filter((b) => !fileBlocks.has(b))), // files ride along with the edit
          flags: ui.V2,
          // "once": people @mentioned by name in this part are still notified; the @everyone/@here/role ping isn't
          allowedMentions: notify === 'none' ? { parse: [] } : allowedMentionsFor(null),
        }
      : null;

    parts.push({ payload, quiet });
  }
  return parts;
}

function renderPreview(guild, session, { skipFiles = false } = {}) {
  const s = skipFiles ? { ...session, files: [] } : session;
  const parts = renderAnnouncement(s, { preview: true });
  const first = parts[0];
  const info = [
    `Posting to <#${s.channelId}>`,
    s.ping
      ? `pings **${pingLabel(guild, s.ping)}**${parts.length > 1 ? (EXTRA_NOTIFY === 'every' ? ' in every part (each part notifies)' : ' in every part (notified once)') : ''}`
      : null,
    parts.length > 1 ? `**${parts.length} messages** (showing part 1)` : null,
    s.crosspost ? 'auto-publish to followers' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  let hiddenFiles = s.files.length && !first.files.length ? `\n-# 📎 ${s.files.length} attachment(s) appear in the last part.` : '';
  if (skipFiles && session.files.length) {
    const list = session.files.map((f) => `${f.name} (${formatBytes(f.size)})`).join(', ');
    hiddenFiles = `\n-# 📎 Too large to preview — uploaded when you publish: ${truncate(list, 400)}`;
  }
  return {
    components: [
      ...first.components,
      ui.divider(true),
      ui.text(`-# 👀 **Preview** — only you can see this. ${info}${hiddenFiles}`),
      ui.row(
        ui.button({ id: `an:pub:${s.id}`, label: 'Publish', emoji: '🚀', style: ButtonStyle.Success }),
        ui.button({ id: `an:edit:${s.id}`, label: 'Edit', emoji: '✏️' }),
        ui.button({ id: `an:style:${s.id}`, label: s.style === 'plain' ? 'Card style' : 'Plain style', emoji: '🎨' }),
        ui.button({ id: `an:x:${s.id}`, label: 'Discard', style: ButtonStyle.Danger }),
      ),
    ],
    files: first.files,
    flags: ui.V2,
    allowedMentions: { parse: [] },
  };
}

/** Shows/refreshes the private preview; if the files are too big for a preview, shows it without them. */
async function showPreview(interaction, guild, s) {
  try {
    return await interaction.editReply({ ...renderPreview(guild, s), attachments: [] });
  } catch (err) {
    if (err?.code !== 40005 && err?.status !== 413) throw err;
    return interaction.editReply({ ...renderPreview(guild, s, { skipFiles: true }), attachments: [] });
  }
}

/* ───────────────────────── modals ───────────────────────── */

function textInput(id, style, max, required, value, placeholder) {
  const t = new TextInputBuilder().setCustomId(id).setStyle(style).setMaxLength(max).setRequired(required);
  if (value) t.setValue(String(value).slice(0, max));
  if (placeholder) t.setPlaceholder(placeholder);
  return t;
}

/** The main composer: Title · Message · More text · Attachments · Footer */
function composeModal(customId, heading, values = {}, { replaceFiles = false } = {}) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(heading)
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Title (optional)')
        .setDescription('Big heading at the top')
        .setTextInputComponent(textInput('title', TextInputStyle.Short, 200, false, values.title, 'Season 3 registrations are OPEN!')),
      new LabelBuilder()
        .setLabel('Message')
        .setDescription('Markdown works: **bold**, lists, links, <#channel>, <@&role>')
        .setTextInputComponent(textInput('body', TextInputStyle.Paragraph, 4000, false, values.body, 'Write your announcement…')),
      new LabelBuilder()
        .setLabel('More text (optional)')
        .setDescription('Need more room? Long posts are split automatically.')
        .setTextInputComponent(textInput('more', TextInputStyle.Paragraph, 4000, false, values.more)),
      new LabelBuilder()
        .setLabel(replaceFiles ? 'Replace attachments (optional)' : 'Attachments (optional)')
        .setDescription(replaceFiles ? 'Leave empty to keep the current files' : 'Up to 10 files — images & videos show as a gallery')
        .setFileUploadComponent(new FileUploadBuilder().setCustomId('files').setMinValues(0).setMaxValues(10).setRequired(false)),
      new LabelBuilder()
        .setLabel('Footer (optional)')
        .setDescription('Small text at the bottom')
        .setTextInputComponent(textInput('footer', TextInputStyle.Short, 200, false, values.footer, `— The ${config.brand.name} Team`)),
    );
}

function pingSelect(guild) {
  const options = [
    new StringSelectMenuOptionBuilder().setLabel('No ping').setValue('none').setEmoji('🔕').setDefault(true),
    new StringSelectMenuOptionBuilder().setLabel('@everyone').setValue('everyone').setEmoji('📣'),
    new StringSelectMenuOptionBuilder().setLabel('@here').setValue('here').setEmoji('📍'),
  ];
  const roles = guild.roles.cache
    .filter((r) => r.id !== guild.id && !r.managed)
    .sort((a, b) => b.position - a.position)
    .first(22);
  for (const r of roles) options.push(new StringSelectMenuOptionBuilder().setLabel(truncate(`@${r.name}`, 100)).setValue(r.id).setEmoji('🏷️'));
  return new StringSelectMenuBuilder().setCustomId('ping').setMinValues(0).setMaxValues(1).setRequired(false).addOptions(options);
}

/** "Post as Announcement" form: Title · Message (prefilled) · Channel · Ping · Footer */
function draftModal(customId, guild, content) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Post as announcement')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Title (optional)')
        .setDescription('Big heading at the top')
        .setTextInputComponent(textInput('title', TextInputStyle.Short, 200, false, null, 'Season 3 registrations are OPEN!')),
      new LabelBuilder()
        .setLabel('Message')
        .setDescription('Copied from the message you picked — edit freely')
        .setTextInputComponent(textInput('body', TextInputStyle.Paragraph, 4000, false, content)),
      new LabelBuilder()
        .setLabel('Post to')
        .setDescription('The draft’s attachments are included automatically')
        .setChannelSelectMenuComponent(
          new ChannelSelectMenuBuilder().setCustomId('channel').setChannelTypes(CHANNEL_TYPES).setMinValues(1).setMaxValues(1).setRequired(true),
        ),
      new LabelBuilder().setLabel('Ping (optional)').setDescription('Who gets notified').setStringSelectMenuComponent(pingSelect(guild)),
      new LabelBuilder()
        .setLabel('Footer (optional)')
        .setDescription('Small text at the bottom')
        .setTextInputComponent(textInput('footer', TextInputStyle.Short, 200, false, null, `— The ${config.brand.name} Team`)),
    );
}

/* ───────────────────────── field readers ───────────────────────── */

const readText = (interaction, id) => {
  try {
    return interaction.fields.getTextInputValue(id).trim();
  } catch {
    return '';
  }
};

const readUploads = (interaction, id) => {
  try {
    return [...(interaction.fields.getUploadedFiles(id)?.values() ?? [])];
  } catch {
    return [];
  }
};

function requiredPerms(guild, a) {
  const perms = ['ViewChannel', 'SendMessages'];
  if (a.files.length) perms.push('AttachFiles');
  if (a.ping === 'everyone' || a.ping === 'here') perms.push('MentionEveryone');
  else if (a.ping && !guild.roles.cache.get(a.ping)?.mentionable) perms.push('MentionEveryone');
  return perms;
}

function assertHasContent(a) {
  if (!a.title && !a.body && !a.more && !a.files.length) {
    throw new UserError('Add a title, some text or at least one file.', 'Announcement is empty');
  }
}

function getChannel(guild, id) {
  const channel = guild.channels.cache.get(id);
  if (!channel?.isTextBased()) throw new UserError('That channel no longer exists.');
  return channel;
}

/* ───────────────────────── publishing ───────────────────────── */

/**
 * Switches the ping on for a part that was sent quiet (and adds its files): Discord re-reads the mentions
 * when a message is edited, so the part turns gold — and edits never notify anyone.
 */
function lightUp(message, payload) {
  return message.edit({ ...payload, flags: ui.V2, ...(payload.files.length ? { attachments: [] } : {}) });
}

/** Posts the parts in order (see renderParts). If anything fails, whatever was posted is removed again. */
async function sendParts(channel, parts) {
  const sent = [];
  try {
    for (const part of parts) {
      const message = await channel.send(part.quiet ?? part.payload);
      sent.push(message);
      if (part.quiet) await lightUp(message, part.payload);
    }
  } catch (err) {
    for (const m of sent) await m.delete().catch(() => {}); // never leave half an announcement behind
    throw err;
  }
  return sent;
}

async function publish(guild, s, userId) {
  const channel = getChannel(guild, s.channelId);
  assertBotChannelPerms(channel, requiredPerms(guild, s));
  s.publishedAt = Date.now();
  const sent = await sendParts(channel, renderParts(s));
  if (s.crosspost && channel.type === ChannelType.GuildAnnouncement) {
    for (const m of sent) await m.crosspost().catch((err) => log.warn('Crosspost failed:', err.message));
  }
  const g = store.guild(guild.id);
  g.announcements[sent[0].id] = {
    channelId: channel.id,
    messageIds: sent.map((m) => m.id),
    title: s.title,
    body: s.body,
    more: s.more,
    footer: s.footer,
    style: s.style,
    color: s.color,
    imagePosition: s.imagePosition,
    ping: s.ping,
    files: s.files.map((f) => ({ name: f.name, kind: f.kind, spoiler: f.spoiler })),
    authorId: userId,
    publishedAt: s.publishedAt,
    editedAt: null,
  };
  const keys = Object.keys(g.announcements);
  if (keys.length > MAX_RECORDS) for (const k of keys.slice(0, keys.length - MAX_RECORDS)) delete g.announcements[k];
  store.save(guild.id);
  // auto reactions go on the last part only, so a split announcement still reads as one post
  autoReact.reactToOwnPost(sent.at(-1));
  return sent[0];
}

function findRecord(guildId, messageId) {
  const all = store.guild(guildId).announcements;
  if (all[messageId]) return [messageId, all[messageId]];
  return Object.entries(all).find(([, r]) => r.messageIds.includes(messageId)) ?? [null, null];
}

/** Fetches a message straight from Discord (skipping the cache). Deleted → null; other errors are thrown. */
async function fetchFresh(channel, messageId) {
  try {
    return await channel.messages.fetch({ message: messageId, force: true });
  } catch (err) {
    if (err?.code === 10008) return null;
    throw err;
  }
}

/** Sent with Discord's "silent" flag (how older versions of the bot posted parts 2+). */
const isSilentMessage = (message) => Boolean(message?.flags?.has?.(MessageFlags.SuppressNotifications));

/**
 * 🔁 Repost (offered after editing an announcement that older versions of the bot posted with silent parts):
 * posts a fresh copy at the bottom of the channel — every part highlighted, nobody notified — and removes the old one.
 */
async function repost(interaction, key, ownerId) {
  if (ownerId !== interaction.user.id) throw new UserError('Only the person who edited the announcement can use this button.');
  const guild = interaction.guild;
  const g = store.guild(guild.id);
  const rec = g.announcements[key];
  if (!rec) throw new UserError('That announcement is no longer tracked — it may have been deleted or reposted already.', 'Nothing to repost');
  await ui.deferUpdate(interaction);
  const channel = getChannel(guild, rec.channelId);
  const old = (await Promise.all(rec.messageIds.map((mid) => fetchFresh(channel, mid)))).filter(Boolean);
  if (!old.length) {
    delete g.announcements[key];
    store.save(guild.id);
    throw new UserError('Every message of this announcement was deleted, so there’s nothing to repost. Post it again with `/announce`.', 'Announcement deleted');
  }
  const files = await carryOverFiles(rec, old);
  const a = { ...rec, files };
  assertBotChannelPerms(channel, requiredPerms(guild, a));
  const sent = await sendParts(channel, renderParts(a, { notify: 'none' }));
  // move the record to the new messages first, so the old messages' delete events don't touch it
  delete g.announcements[key];
  g.announcements[sent[0].id] = {
    ...rec,
    messageIds: sent.map((m) => m.id),
    files: files.map((f) => ({ name: f.name, kind: f.kind, spoiler: f.spoiler })),
    editedAt: Date.now(),
  };
  store.save(guild.id);
  for (const m of old) await m.delete().catch(() => {});
  autoReact.reactToOwnPost(sent.at(-1));
  const lostFiles = rec.files.length - files.length;
  const body = [
    `The fresh copy is at the bottom of <#${channel.id}> and reads as one post. The old one was removed, and nobody was pinged.`,
    lostFiles > 0 ? `-# ${lostFiles} attachment(s) were on a deleted message and couldn’t be kept — add them again with **Edit Announcement**.` : null,
  ];
  return interaction.editReply(
    ui.notice('success', 'Announcement reposted', body.filter(Boolean).join('\n'), {
      buttons: [ui.button({ label: 'Open announcement', emoji: '🔗', url: sent[0].url })],
    }),
  );
}

/** Re-downloads the files already on an announcement so they survive an edit. */
async function carryOverFiles(rec, messages) {
  const out = [];
  for (const meta of rec.files) {
    let att = null;
    for (const m of messages) {
      att = m?.attachments.find((x) => x.name === meta.name) ?? null;
      if (att) break;
    }
    if (!att) continue;
    const buffer = await download(att.url);
    out.push({ ...meta, buffer, size: buffer.length });
  }
  return out;
}

/* ───────────────────────── entry points ───────────────────────── */

/** /announce */
async function command(interaction) {
  const guild = interaction.guild;
  const channel = interaction.options.getChannel('channel', true);
  const colorIn = interaction.options.getString('color');
  let color = null;
  if (colorIn && !isDefaultColorKeyword(colorIn)) {
    color = parseColor(colorIn);
    if (color === null) throw new UserError('Colours look like `#7C5CFF` or a name like `purple`, `gold`, `cyan`.', 'Invalid colour');
  }
  const s = newSession({
    id: interaction.id,
    guildId: guild.id,
    userId: interaction.user.id,
    channelId: channel.id,
    ping: resolvePing(guild, interaction.options.getString('ping')),
    style: interaction.options.getString('style') ?? 'card',
    imagePosition: interaction.options.getString('images') ?? 'top',
    crosspost: interaction.options.getBoolean('crosspost') ?? false,
    color,
  });
  assertBotChannelPerms(getChannel(guild, channel.id), requiredPerms(guild, { ...s, files: [] }));
  sessions.set(s.id, s);
  return interaction.showModal(composeModal(`an:new:${s.id}`, 'New announcement'));
}

/** Message context menu → "Post as Announcement" */
async function postAsAnnouncement(interaction) {
  const msg = interaction.targetMessage;
  if (!msg.content && !msg.attachments.size) throw new UserError('That message has no text or files to post.', 'Nothing to post');
  const s = newSession({
    id: interaction.id,
    guildId: interaction.guildId,
    userId: interaction.user.id,
    draft: [...msg.attachments.values()].map((a) => ({ url: a.url, name: a.name, size: a.size, contentType: a.contentType })),
  });
  sessions.set(s.id, s);
  return interaction.showModal(draftModal(`an:draft:${s.id}`, interaction.guild, msg.content || ''));
}

/** Message context menu → "Edit Announcement" */
async function editAnnouncement(interaction) {
  const msg = interaction.targetMessage;
  if (msg.author.id !== interaction.client.user.id) throw new UserError('I can only edit announcements that I posted.', 'Not my message');
  const [key, rec] = findRecord(interaction.guildId, msg.id);
  if (!rec) throw new UserError('I can only edit announcements made with /announce or “Post as Announcement”.', 'Not an announcement');
  return interaction.showModal(composeModal(`an:editpost:${key}`, 'Edit announcement', rec, { replaceFiles: true }));
}

async function onModal(interaction) {
  const [, action, id] = interaction.customId.split(':');
  const guild = interaction.guild;

  if (action === 'editpost') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const g = store.guild(guild.id);
    const rec = g.announcements[id];
    if (!rec) throw new UserError('That announcement is no longer tracked.');
    const channel = getChannel(guild, rec.channelId);
    // ask Discord, not the bot's memory — a part may have been deleted without the bot noticing
    const messages = await Promise.all(rec.messageIds.map((mid) => fetchFresh(channel, mid)));
    const live = messages.filter(Boolean);
    if (!live.length) {
      delete g.announcements[id];
      store.save(guild.id);
      throw new UserError('Every message of this announcement was deleted, so there’s nothing left to edit. Post it again with `/announce`.', 'Announcement deleted');
    }
    const uploads = readUploads(interaction, 'files');
    const files = uploads.length ? await downloadAttachments(uploads) : await carryOverFiles(rec, live);
    const lostFiles = uploads.length ? 0 : rec.files.length - files.length;
    const a = {
      ...rec,
      title: readText(interaction, 'title'),
      body: readText(interaction, 'body'),
      more: readText(interaction, 'more'),
      footer: readText(interaction, 'footer'),
      files,
    };
    assertHasContent(a);
    const parts = renderParts(a, { notify: 'none' }); // an edit never notifies anyone — not even for added parts
    let appended = 0;
    try {
      for (let i = 0; i < parts.length; i++) {
        const { payload, quiet } = parts[i];
        // keeps the ping's mentions so every part stays highlighted — edits never notify anyone
        if (live[i]) await live[i].edit({ ...payload, flags: ui.V2, attachments: [] });
        else {
          const message = await channel.send(quiet ?? payload);
          live.push(message);
          appended++;
          if (quiet) await lightUp(message, payload);
        }
      }
    } catch (err) {
      if (err?.code === 10008) throw new UserError('A message of this announcement was deleted while I was editing it. Please try again.', 'Message deleted');
      throw err;
    }
    for (let i = parts.length; i < live.length; i++) await live[i].delete().catch(() => {});
    // posted by an older version of the bot: parts 2+ carry Discord's "silent" flag, which can't be removed
    // and makes Discord repeat the bot's name above them → offer a clean repost
    const legacySilent = live.slice(1, parts.length).some(isSilentMessage);
    Object.assign(rec, {
      title: a.title,
      body: a.body,
      more: a.more,
      footer: a.footer,
      files: files.map((f) => ({ name: f.name, kind: f.kind, spoiler: f.spoiler })),
      messageIds: live.slice(0, parts.length).map((m) => m.id),
      editedAt: Date.now(),
    });
    // announcements are tracked by their first message — move the record if that one was deleted
    if (rec.messageIds[0] !== id) {
      delete g.announcements[id];
      g.announcements[rec.messageIds[0]] = rec;
    }
    store.save(guild.id);
    const notes = [
      messages[0] ? null : '-# The first message had been deleted, so the announcement now starts at its next message.',
      lostFiles > 0 ? `-# ${lostFiles} attachment(s) were on a deleted message and couldn’t be kept — add them again with **Edit Announcement**.` : null,
      appended ? `-# The longer text needed ${appended} extra message(s), added at the end of the channel.` : null,
      legacySilent
        ? '**Why does the bot’s name show up again above part 2?**\n' +
          'This announcement was posted by an older version of the bot, which sent parts 2+ as Discord “silent” messages — ' +
          'and Discord always gives a silent message its own name header. Discord doesn’t let bots change that on a message that’s already posted.\n' +
          `-# **🔁 Repost** posts a fresh copy at the bottom of <#${channel.id}> that reads as one post (every part still highlighted), then removes this one. Nobody gets pinged.`
        : null,
    ].filter(Boolean);
    const buttons = [ui.button({ label: 'Open announcement', emoji: '🔗', url: live[0].url })];
    if (legacySilent) buttons.push(ui.button({ id: `an:repost:${rec.messageIds[0]}:${interaction.user.id}`, label: 'Repost', emoji: '🔁', style: ButtonStyle.Primary }));
    return interaction.editReply(ui.notice('success', 'Announcement updated', notes.join('\n') || null, { buttons }));
  }

  const s = sessions.get(id);
  if (!s) throw new UserError('This draft expired (drafts last 30 minutes). Please start again.', 'Draft expired');

  if (action === 'new' || action === 'draft') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    s.title = readText(interaction, 'title');
    s.body = readText(interaction, 'body');
    s.more = readText(interaction, 'more');
    s.footer = readText(interaction, 'footer');
    if (action === 'new') {
      s.files = await downloadAttachments(readUploads(interaction, 'files'));
    } else {
      const picked = interaction.fields.getSelectedChannels('channel')?.first();
      if (!picked) throw new UserError('Pick a channel to post in.');
      s.channelId = picked.id;
      let ping = null;
      try {
        ping = interaction.fields.getStringSelectValues('ping')[0] ?? null;
      } catch {
        ping = null;
      }
      s.ping = ping && ping !== 'none' ? ping : null;
      s.files = await downloadAttachments(s.draft);
      assertBotChannelPerms(getChannel(guild, s.channelId), requiredPerms(guild, s));
    }
    assertHasContent(s);
    s.updatedAt = Date.now();
    return showPreview(interaction, guild, s);
  }

  if (action === 'upd') {
    await ui.deferUpdate(interaction);
    s.title = readText(interaction, 'title');
    s.body = readText(interaction, 'body');
    s.more = readText(interaction, 'more');
    s.footer = readText(interaction, 'footer');
    const uploads = readUploads(interaction, 'files');
    if (uploads.length) s.files = await downloadAttachments(uploads);
    assertHasContent(s);
    s.updatedAt = Date.now();
    return showPreview(interaction, guild, s);
  }

  throw new UserError('Unknown form.');
}

async function onButton(interaction) {
  const [, action, id, extra] = interaction.customId.split(':');
  if (action === 'repost') return repost(interaction, id, extra);
  const s = sessions.get(id);
  if (!s) {
    return interaction.update({ ...ui.notice('warn', 'Draft expired', 'Drafts last 30 minutes — please start again.'), attachments: [] });
  }
  if (s.userId !== interaction.user.id) throw new UserError('This draft belongs to someone else.');
  const guild = interaction.guild;
  s.updatedAt = Date.now();

  switch (action) {
    case 'pub': {
      await ui.deferUpdate(interaction);
      const msg = await publish(guild, s, interaction.user.id);
      sessions.delete(id);
      const size = s.files.reduce((n, f) => n + f.size, 0);
      return interaction.editReply({
        ...ui.notice('success', 'Announcement published', `Posted in <#${s.channelId}>${s.files.length ? ` with ${s.files.length} file(s) (${formatBytes(size)})` : ''}.\n-# Need a change? Right-click it → **Apps → Edit Announcement**.`, {
          buttons: [ui.button({ label: 'Open announcement', emoji: '🔗', url: msg.url })],
        }),
        attachments: [],
      });
    }
    case 'edit':
      return interaction.showModal(composeModal(`an:upd:${id}`, 'Edit announcement', s, { replaceFiles: true }));
    case 'style':
      s.style = s.style === 'plain' ? 'card' : 'plain';
      await ui.deferUpdate(interaction);
      return showPreview(interaction, guild, s);
    case 'x':
      sessions.delete(id);
      return interaction.update({ ...ui.notice('info', 'Draft discarded', 'Nothing was posted.'), attachments: [] });
    default:
      throw new UserError('This button is outdated.');
  }
}

/* ───────────────────────── autocomplete & cleanup ───────────────────────── */

function pingChoices(guild, query) {
  const q = String(query || '').toLowerCase().replace(/^@/, '');
  const base = [
    { name: '🔕 No ping', value: 'none' },
    { name: '📣 @everyone', value: 'everyone' },
    { name: '📍 @here', value: 'here' },
  ].filter((c) => !q || c.value.includes(q));
  const roles = guild.roles.cache
    .filter((r) => r.id !== guild.id && !r.managed && (!q || r.name.toLowerCase().includes(q)))
    .sort((a, b) => b.position - a.position)
    .first(22)
    .map((r) => ({ name: truncate(`🏷️ @${r.name}`, 100), value: r.id }));
  return [...base, ...roles].slice(0, 25);
}

/** Keeps records in sync when announcement messages are deleted (the rest stays editable). */
function onMessageDelete(guildId, messageId) {
  const all = store.guilds[guildId]?.announcements;
  if (!all) return;
  const key = all[messageId] ? messageId : Object.keys(all).find((k) => all[k].messageIds.includes(messageId));
  if (!key) return;
  const rec = all[key];
  rec.messageIds = rec.messageIds.filter((mid) => mid !== messageId);
  if (!rec.messageIds.length) delete all[key];
  else if (rec.messageIds[0] !== key) {
    delete all[key]; // first message gone → the announcement now starts at its next message
    all[rec.messageIds[0]] = rec;
  }
  store.save(guildId);
}

module.exports = {
  command,
  postAsAnnouncement,
  editAnnouncement,
  onModal,
  onButton,
  pingChoices,
  onMessageDelete,
  renderAnnouncement,
  renderParts,
  renderPreview,
  newSession,
  CHANNEL_TYPES,
};
