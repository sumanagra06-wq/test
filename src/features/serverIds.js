'use strict';
const { AttachmentBuilder, ButtonStyle, ChannelType, FileBuilder, PermissionFlagsBits, escapeMarkdown } = require('discord.js');
const config = require('../config');
const ui = require('../lib/ui');
const { safeFileName } = require('../lib/utils');

/**
 * /ids — the whole server at a glance: every category with its channels (in sidebar order) and every
 * role, each with its ID. Shown privately in pages, plus a .txt file with everything in one place.
 */

const PAGE_CHARS = 3200; // list characters per page (Discord allows 4,000 characters per message in total)

const ICON = {
  [ChannelType.GuildText]: '#',
  [ChannelType.GuildAnnouncement]: '📢',
  [ChannelType.GuildVoice]: '🔊',
  [ChannelType.GuildStageVoice]: '🎙️',
  [ChannelType.GuildForum]: '💬',
  [ChannelType.GuildMedia]: '🖼️',
  [ChannelType.GuildDirectory]: '📚',
};
const VOICE_LIKE = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);
const LEGEND = '# text · 📢 announcement · 🔊 voice · 🎙️ stage · 💬 forum · 🖼️ media · 🔒 private · 🤖 bot role · 🛡️ admin';
const LEGEND_MD = LEGEND.replace(/^# /, '`#` '); // a leading "# " could turn into a heading in Discord

const idOrder = (a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
const positionOrder = (a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0) || idOrder(a, b);
/** Same order as Discord's sidebar: text-like channels first, then voice-like, each by position. */
const sidebarOrder = (a, b) => (VOICE_LIKE.has(a.type) ? 1 : 0) - (VOICE_LIKE.has(b.type) ? 1 : 0) || positionOrder(a, b);

/** Backticks would break the code block and line breaks the tree. */
const clean = (name) => String(name ?? '').replace(/`/g, 'ˋ').replace(/\s+/g, ' ').trim() || '(no name)';

/** 🔒 = @everyone can't see it. */
function isPrivate(guild, channel) {
  try {
    const perms = channel.permissionsFor?.(guild.roles.everyone);
    return perms ? !perms.has(PermissionFlagsBits.ViewChannel) : false;
  } catch {
    return false;
  }
}

/**
 * Every line of the map. `head` marks group headers (kept together with their first line);
 * `cat` is the category header a channel belongs to (repeated when a page starts mid-category).
 */
function buildMap(guild) {
  const all = [...guild.channels.cache.values()].filter((c) => !c.isThread?.());
  const categories = all.filter((c) => c.type === ChannelType.GuildCategory).sort(positionOrder);
  const catIds = new Set(categories.map((c) => c.id));
  const channels = all.filter((c) => c.type !== ChannelType.GuildCategory);
  const roles = [...guild.roles.cache.values()].sort((a, b) => b.position - a.position || idOrder(a, b));

  const lines = [];
  const channelLine = (ch, last) => `${last ? '└─' : '├─'} ${ICON[ch.type] ?? '•'} ${clean(ch.name)}${isPrivate(guild, ch) ? ' 🔒' : ''} — ${ch.id}`;
  const group = (head, kids) => {
    lines.push({ text: '' }, { text: head, head: true });
    if (!kids.length) lines.push({ text: '   (empty)', cat: head });
    kids.forEach((ch, i) => lines.push({ text: channelLine(ch, i === kids.length - 1), cat: head }));
  };

  lines.push({ text: `CHANNELS · ${categories.length} categories · ${channels.length} channels`, head: true });
  const loose = channels.filter((c) => !catIds.has(c.parentId)).sort(sidebarOrder);
  if (loose.length) group('(no category)', loose);
  for (const cat of categories) {
    group(`📁 ${clean(cat.name)}${isPrivate(guild, cat) ? ' 🔒' : ''} — ${cat.id}`, channels.filter((c) => c.parentId === cat.id).sort(sidebarOrder));
  }

  lines.push({ text: '' }, { text: `ROLES · ${roles.length} (highest first)`, head: true, roles: true });
  for (const r of roles) {
    const marks = [r.managed ? '🤖' : null, r.permissions?.has?.(PermissionFlagsBits.Administrator) ? '🛡️' : null].filter(Boolean).join(' ');
    lines.push({ text: `${clean(r.name)}${marks ? ` ${marks}` : ''} — ${r.id}` });
  }
  return { lines, stats: { categories: categories.length, channels: channels.length, roles: roles.length } };
}

/** Splits the map into pages that fit a Discord message. Returns the pages and the page where roles start. */
function paginate(lines) {
  const pages = [];
  let page = [];
  let size = 0;
  let rolesPage = 0;
  const flush = () => {
    while (page.length && !page.at(-1)) page.pop(); // no trailing blank lines
    if (page.length) pages.push(page);
    page = [];
    size = 0;
  };
  lines.forEach((l, i) => {
    // a header needs room for itself and its first line, so it never ends up alone at the bottom of a page
    const needed = l.text.length + 1 + (l.head ? (lines[i + 1]?.text.length ?? 0) + 1 : 0);
    if (page.length && size + needed > PAGE_CHARS) {
      flush();
      if (l.cat) {
        const again = `${l.cat} (continued)`;
        page.push(again);
        size += again.length + 1;
      }
    }
    if (!page.length && !l.text) return; // never start a page with a blank line
    if (l.roles) rolesPage = pages.length;
    page.push(l.text);
    size += l.text.length + 1;
  });
  flush();
  return { pages, rolesPage };
}

function fileText(guild, lines, stats) {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return [
    `${guild.name} — server ID ${guild.id}`,
    `${stats.categories} categories · ${stats.channels} channels · ${stats.roles} roles · generated ${stamp} UTC`,
    `Legend: ${LEGEND}`,
    '',
    ...lines.map((l) => l.text),
    '',
  ].join('\n');
}

/** The private /ids view for one page (with the full .txt attached). */
function render(guild, requestedPage = 0) {
  const { lines, stats } = buildMap(guild);
  const { pages, rolesPage } = paginate(lines);
  const n = pages.length;
  const p = Math.min(Math.max(0, Number.isInteger(requestedPage) ? requestedPage : 0), n - 1);
  const fileName = safeFileName(`${guild.name}-ids.txt`);

  const c = ui.container(config.brand.color);
  c.addTextDisplayComponents(
    ui.text(`## 🗂️ ${escapeMarkdown(clean(guild.name))}\n-# Server ID \`${guild.id}\` · ${stats.categories} categories · ${stats.channels} channels · ${stats.roles} roles`),
    ui.text(`\`\`\`\n${pages[p].join('\n')}\n\`\`\``),
    ui.text(`-# ${n > 1 ? `Page ${p + 1} of ${n} · ` : ''}${LEGEND_MD}`),
  );
  c.addSeparatorComponents(ui.divider());
  c.addFileComponents(new FileBuilder().setURL(`attachment://${fileName}`));
  if (n > 1) {
    c.addActionRowComponents(
      ui.row(
        ui.button({ id: `ids:go:${p - 1}:prev`, label: 'Previous', emoji: '◀️', disabled: p === 0 }),
        ui.button({ id: `ids:go:${p + 1}:next`, label: 'Next', emoji: '▶️', disabled: p === n - 1 }),
        ui.button({ id: 'ids:go:0:channels', label: 'Channels', emoji: '📁', style: p < rolesPage ? ButtonStyle.Primary : ButtonStyle.Secondary }),
        ui.button({ id: `ids:go:${rolesPage}:roles`, label: 'Roles', emoji: '🎭', style: p >= rolesPage ? ButtonStyle.Primary : ButtonStyle.Secondary }),
      ),
    );
  }
  const file = new AttachmentBuilder(Buffer.from(fileText(guild, lines, stats), 'utf8'), { name: fileName });
  return { components: [c], files: [file], flags: ui.V2, allowedMentions: { parse: [] } };
}

/** /ids */
async function command(interaction) {
  return ui.respond(interaction, render(interaction.guild, 0));
}

/** Page buttons: ids:go:<page>:<which> */
async function onComponent(interaction) {
  const [, action, page] = interaction.customId.split(':');
  if (action !== 'go') return;
  return ui.updateMessage(interaction, { ...render(interaction.guild, Number.parseInt(page, 10)), attachments: [] });
}

module.exports = { command, onComponent, render, buildMap, paginate };
