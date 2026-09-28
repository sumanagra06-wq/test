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
function renderAnnouncement(a, { preview = false } = {}) {
  const body = [a.body, a.more].map((s) => String(s || '').trim()).filter(Boolean).join('\n\n');
  for (let size = 3000; size >= 1000; size -= 250) {
    const parts = buildParts(a, body, size, preview);
    if (parts.every((p) => ui.textLength(p.components) <= TEXT_BUDGET)) return parts;
  }
  return buildParts(a, body, 900, preview);
}

function buildParts(a, body, chunkSize, preview) {
  const card = a.style !== 'plain';
  const color = a.color ?? config.brand.color;
  const chunks = body ? chunkText(body, chunkSize) : [''];
  const n = chunks.length;
  const media = a.files.filter((f) => f.kind !== 'file');
  const docs = a.files.filter((f) => f.kind === 'file');
  const mediaPart = a.imagePosition === 'bottom' ? n - 1 : 0;
  const ts = Math.floor((a.publishedAt ?? Date.now()) / 1000);
  const parts = [];

  for (let i = 0; i < n; i++) {
    const blocks = [];
    const files = [];
    const addMedia = () => {
      if (!media.length || i !== mediaPart) return;
      blocks.push(ui.gallery(media.slice(0, 10).map((f) => ({ url: `attachment://${f.name}`, spoiler: f.spoiler }))));
      files.push(...media.slice(0, 10));
    };

    if (i === 0 && a.imagePosition !== 'bottom') addMedia();
    if (i === 0) {
      const header = [card ? `-# 📢  ${config.brand.name} · Announcement` : null, a.title ? `# ${a.title}` : null].filter(Boolean).join('\n');
      if (header) blocks.push(ui.text(header));
    }
    if (chunks[i]) blocks.push(ui.text(chunks[i]));
    if (i === n - 1) {
      if (a.imagePosition === 'bottom') addMedia();
      for (const f of docs) {
        const fb = new FileBuilder().setURL(`attachment://${f.name}`);
        if (f.spoiler) fb.setSpoiler(true);
        blocks.push(fb);
        files.push(f);
      }
      const footer = [a.footer, card ? `<t:${ts}:f>` : null].filter(Boolean).join(' · ');
      if (footer) blocks.push(ui.divider(), ui.text(`-# ${footer}`));
    }
    if (!blocks.length) blocks.push(ui.text('\u200b'));

    const components = [];
    if (i === 0 && a.ping) components.push(ui.text(pingText(a.ping)));
    if (card) components.push(ui.fillContainer(ui.container(color), blocks));
    else components.push(...blocks);

    parts.push({
      components,
      files: files.map((f) => new AttachmentBuilder(f.buffer, { name: f.name })),
      flags: ui.V2,
      allowedMentions: preview ? { parse: [] } : i === 0 ? allowedMentionsFor(a.ping) : { parse: ['users'] },
    });
  }
  return parts;
}

function renderPreview(guild, session, { skipFiles = false } = {}) {
  const s = skipFiles ? { ...session, files: [] } : session;
  const parts = renderAnnouncement(s, { preview: true });
  const first = parts[0];
  const info = [
    `Posting to <#${s.channelId}>`,
    s.ping ? `pings **${pingLabel(guild, s.ping)}**` : null,
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

async function publish(guild, s, userId) {
  const channel = getChannel(guild, s.channelId);
  assertBotChannelPerms(channel, requiredPerms(guild, s));
  s.publishedAt = Date.now();
  const parts = renderAnnouncement(s);
  const sent = [];
  try {
    for (const p of parts) sent.push(await channel.send(p));
  } catch (err) {
    for (const m of sent) await m.delete().catch(() => {}); // never leave half an announcement behind
    throw err;
  }
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
  return sent[0];
}

function findRecord(guildId, messageId) {
  const all = store.guild(guildId).announcements;
  if (all[messageId]) return [messageId, all[messageId]];
  return Object.entries(all).find(([, r]) => r.messageIds.includes(messageId)) ?? [null, null];
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
    const rec = store.guild(guild.id).announcements[id];
    if (!rec) throw new UserError('That announcement is no longer tracked.');
    const channel = getChannel(guild, rec.channelId);
    const messages = await Promise.all(rec.messageIds.map((mid) => channel.messages.fetch(mid).catch(() => null)));
    if (!messages[0]) throw new UserError('The original message was deleted.');
    const uploads = readUploads(interaction, 'files');
    const files = uploads.length ? await downloadAttachments(uploads) : await carryOverFiles(rec, messages);
    const a = {
      ...rec,
      title: readText(interaction, 'title'),
      body: readText(interaction, 'body'),
      more: readText(interaction, 'more'),
      footer: readText(interaction, 'footer'),
      files,
    };
    assertHasContent(a);
    const parts = renderAnnouncement(a);
    const live = messages.filter(Boolean);
    let appended = 0;
    for (let i = 0; i < parts.length; i++) {
      const payload = { ...parts[i], allowedMentions: { parse: [] } };
      if (live[i]) await live[i].edit({ ...payload, attachments: [] });
      else {
        live.push(await channel.send(payload));
        appended++;
      }
    }
    for (let i = parts.length; i < live.length; i++) await live[i].delete().catch(() => {});
    Object.assign(rec, {
      title: a.title,
      body: a.body,
      more: a.more,
      footer: a.footer,
      files: files.map((f) => ({ name: f.name, kind: f.kind, spoiler: f.spoiler })),
      messageIds: live.slice(0, parts.length).map((m) => m.id),
      editedAt: Date.now(),
    });
    store.save(guild.id);
    return interaction.editReply(
      ui.notice('success', 'Announcement updated', appended ? `-# The longer text needed ${appended} extra message(s), added at the end of the channel.` : null, {
        buttons: [ui.button({ label: 'Open announcement', emoji: '🔗', url: messages[0].url })],
      }),
    );
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
  const [, action, id] = interaction.customId.split(':');
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

function onMessageDelete(guildId, messageId) {
  const g = store.guilds[guildId];
  if (g?.announcements?.[messageId]) {
    delete g.announcements[messageId];
    store.save(guildId);
  }
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
  renderPreview,
  newSession,
  CHANNEL_TYPES,
};
