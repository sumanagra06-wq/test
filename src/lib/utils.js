'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { PermissionFlagsBits } = require('discord.js');

/** An error whose message is safe (and useful) to show to the person who ran the command. */
class UserError extends Error {
  constructor(message, title = 'Something needs fixing') {
    super(message);
    this.name = 'UserError';
    this.title = title;
  }
}

const NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

/**
 * True when Discord's own servers failed (HTTP 5xx) or the connection to Discord dropped/timed out.
 * These are temporary problems on Discord's side, not bugs in the bot — trying again usually works.
 */
function isDiscordHiccup(err) {
  return (err?.name === 'HTTPError' && err.status >= 500) || err?.name === 'AbortError' || NETWORK_CODES.has(err?.code);
}

/** Short description of a Discord hiccup for the logs, e.g. "503 Service Unavailable". */
function hiccupText(err) {
  return [err?.status ?? err?.code ?? err?.name, err?.message].filter(Boolean).join(' ');
}

/* ────────────────────────── text helpers ────────────────────────── */

function truncate(str, max) {
  const s = String(str ?? '');
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…` : s;
}

function ordinal(n) {
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
  return `${n.toLocaleString('en-US')}${suffix}`;
}

/** Replaces {placeholders} (case-insensitive). Unknown placeholders are left untouched. */
function fillTemplate(template, vars) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (match, key) => {
    const k = key.toLowerCase();
    return Object.hasOwn(vars, k) ? String(vars[k]) : match;
  });
}

/**
 * Splits long text into chunks ≤ max characters, preferring paragraph → line → word
 * boundaries and keeping ``` code blocks balanced across chunks.
 */
function chunkText(input, max) {
  const chunks = [];
  let rest = String(input ?? '').trim();
  let reopenFence = false;
  while (rest.length) {
    if (reopenFence) rest = '```\n' + rest;
    reopenFence = false;
    if (rest.length <= max) {
      chunks.push(rest);
      break;
    }
    const limit = max - 4; // leave room to close a code fence
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit * 0.5) cut = limit;
    let piece = rest.slice(0, cut).trimEnd();
    rest = rest.slice(cut).trimStart();
    if ((piece.match(/```/g) || []).length % 2 === 1) {
      piece += '\n```';
      reopenFence = true;
    }
    chunks.push(piece);
  }
  return chunks.filter((c) => c.trim().length);
}

function shortId(len = 6) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

/* ────────────────────────── message links ────────────────────────── */

/** Accepts a message link, "channelId-messageId" (Shift+Copy ID) or a bare message ID. */
function parseMessageRef(input) {
  const s = String(input ?? '').trim();
  let m = s.match(/discord(?:app)?\.com\/channels\/(\d+|@me)\/(\d{15,21})\/(\d{15,21})/);
  if (m) return { guildId: m[1], channelId: m[2], messageId: m[3] };
  m = s.match(/^(\d{15,21})-(\d{15,21})$/);
  if (m) return { channelId: m[1], messageId: m[2] };
  m = s.match(/^(\d{15,21})$/);
  if (m) return { channelId: null, messageId: m[1] };
  return null;
}

function messageUrl(guildId, channelId, messageId) {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

function channelUrl(guildId, channelId) {
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

/* ────────────────────────── emoji ────────────────────────── */

const CUSTOM_EMOJI_RE = /^<(a?):([\w~]{1,32}):(\d{15,21})>$/;
const UNICODE_EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u;

const stripVariation = (s) => String(s ?? '').replace(/\uFE0F/g, '');

/**
 * Parses what an admin typed into an emoji option.
 * @returns {{id: string|null, name: string, animated: boolean}|null}
 */
function parseEmoji(input, guild) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  let m = s.match(CUSTOM_EMOJI_RE);
  if (m) return { id: m[3], name: m[2], animated: Boolean(m[1]) };
  if (/^\d{15,21}$/.test(s) && guild) {
    const e = guild.emojis.cache.get(s);
    if (e) return { id: e.id, name: e.name, animated: e.animated };
  }
  m = s.match(/^:?([\w~]{2,32}):?$/);
  if (m && guild) {
    const e = guild.emojis.cache.find((x) => x.name === m[1]) ?? guild.emojis.cache.find((x) => x.name?.toLowerCase() === m[1].toLowerCase());
    if (e) return { id: e.id, name: e.name, animated: e.animated };
  }
  if (UNICODE_EMOJI_RE.test(s) && s.length <= 32 && !/\s/.test(s)) {
    return { id: null, name: s, animated: false };
  }
  return null;
}

/** Stable key used to match reactions to configured emoji. */
function emojiKey(emoji) {
  if (!emoji) return '';
  return emoji.id ? String(emoji.id) : stripVariation(emoji.name);
}

/** Emoji as text for messages, e.g. "<:gg:123>" or "🎮". */
function emojiText(emoji) {
  if (!emoji) return '';
  return emoji.id ? `<${emoji.animated ? 'a' : ''}:${emoji.name || 'e'}:${emoji.id}>` : emoji.name;
}

/** Emoji object for buttons / select options. */
function emojiComponent(emoji) {
  if (!emoji) return undefined;
  return emoji.id ? { id: emoji.id, name: emoji.name, animated: Boolean(emoji.animated) } : { name: emoji.name };
}

/* ────────────────────────── roles & permissions ────────────────────────── */

const DANGEROUS_PERMS = [
  ['Administrator', PermissionFlagsBits.Administrator],
  ['Manage Server', PermissionFlagsBits.ManageGuild],
  ['Manage Roles', PermissionFlagsBits.ManageRoles],
  ['Manage Channels', PermissionFlagsBits.ManageChannels],
  ['Manage Webhooks', PermissionFlagsBits.ManageWebhooks],
  ['Ban Members', PermissionFlagsBits.BanMembers],
  ['Kick Members', PermissionFlagsBits.KickMembers],
  ['Moderate Members', PermissionFlagsBits.ModerateMembers],
  ['Manage Messages', PermissionFlagsBits.ManageMessages],
  ['Mention Everyone', PermissionFlagsBits.MentionEveryone],
];

/**
 * Checks whether the bot can hand out a role at all.
 * @returns {string|null} a human-readable problem, or null when fine
 */
function botRoleProblem(guild, role) {
  if (!role) return 'That role no longer exists.';
  if (role.id === guild.id) return 'The @everyone role can’t be handed out.';
  if (role.managed) return `${role} is managed by an integration (a bot or booster role) and can’t be assigned.`;
  const me = guild.members.me;
  if (!me) return 'I’m still starting up — try again in a few seconds.';
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) return 'I need the **Manage Roles** permission.';
  if (me.roles.highest.comparePositionTo(role) <= 0) {
    return `My highest role (${me.roles.highest}) must be **above** ${role}. Drag my role higher in **Server Settings → Roles**.`;
  }
  return null;
}

/**
 * Checks whether it is *safe* to let members self-assign a role, and whether the admin
 * configuring it is allowed to (prevents handing out roles above your own).
 */
function selfAssignProblem(member, role) {
  const guild = member.guild;
  const botIssue = botRoleProblem(guild, role);
  if (botIssue) return botIssue;
  const dangerous = DANGEROUS_PERMS.filter(([, flag]) => role.permissions.has(flag, false)).map(([n]) => n);
  if (dangerous.length) {
    return `${role} has powerful permissions (**${dangerous.join(', ')}**). For safety it can’t be self-assigned.`;
  }
  const isOwner = guild.ownerId === member.id;
  if (!isOwner && member.roles.highest.comparePositionTo(role) <= 0) {
    return `You can only use roles that are **below** your own highest role (${member.roles.highest}).`;
  }
  return null;
}

/** Throws a UserError listing missing channel permissions for the bot. */
function assertBotChannelPerms(channel, perms) {
  const me = channel.guild.members.me;
  const have = channel.permissionsFor(me);
  const names = {
    ViewChannel: 'View Channel',
    SendMessages: 'Send Messages',
    SendMessagesInThreads: 'Send Messages in Threads',
    AttachFiles: 'Attach Files',
    EmbedLinks: 'Embed Links',
    ReadMessageHistory: 'Read Message History',
    AddReactions: 'Add Reactions',
    UseExternalEmojis: 'Use External Emoji',
    MentionEveryone: 'Mention @everyone, @here and All Roles',
    ManageMessages: 'Manage Messages',
  };
  const missing = perms.filter((p) => !have?.has(PermissionFlagsBits[p]));
  if (missing.length) {
    throw new UserError(
      `I’m missing permissions in ${channel}: **${missing.map((p) => names[p] || p).join(', ')}**.\nGive my role these permissions in that channel’s settings and try again.`,
      'Missing permissions',
    );
  }
}

/* ────────────────────────── files ────────────────────────── */

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v']);

function fileKind(name, contentType) {
  const ct = String(contentType || '').toLowerCase();
  const ext = path.extname(String(name || '')).toLowerCase();
  if (ct.startsWith('image/') || IMAGE_EXT.has(ext)) return 'image';
  if (ct.startsWith('video/') || VIDEO_EXT.has(ext)) return 'video';
  return 'file';
}

/** Makes a filename safe for `attachment://` references and unique within `used`. */
function safeFileName(name, used = new Set()) {
  const raw = String(name || 'file');
  const ext = path.extname(raw).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
  let base = path
    .basename(raw, path.extname(raw))
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.-]+|[_.-]+$/g, '')
    .slice(0, 60);
  if (!base) base = 'file';
  let candidate = `${base}${ext}`;
  let i = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${base}-${i++}${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Downloads a URL into a Buffer with a size cap. */
async function download(url, maxBytes = 100 * 1024 * 1024) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) throw new UserError(`A file is too large (${formatBytes(declared)}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new UserError(`A file is too large (${formatBytes(buf.length)}).`);
  return buf;
}

/**
 * Downloads Discord attachments (from a modal upload, slash option, or a message).
 * @returns {Promise<Array<{name, buffer, size, kind, spoiler, contentType}>>}
 */
async function downloadAttachments(attachments, { maxTotal = 200 * 1024 * 1024 } = {}) {
  const list = [...(attachments ?? [])];
  if (!list.length) return [];
  const total = list.reduce((sum, a) => sum + (a.size || 0), 0);
  if (total > maxTotal) throw new UserError(`Attachments are too large in total (${formatBytes(total)}).`);
  const used = new Set();
  return Promise.all(
    list.map(async (a) => {
      const buffer = await download(a.url);
      const originalName = a.name || a.filename || 'file';
      const spoiler = /^SPOILER_/i.test(originalName);
      const name = safeFileName(originalName.replace(/^SPOILER_/i, ''), used);
      return {
        name,
        buffer,
        size: buffer.length,
        kind: fileKind(originalName, a.contentType ?? a.content_type),
        spoiler,
        contentType: a.contentType ?? a.content_type ?? null,
      };
    }),
  );
}

module.exports = {
  UserError,
  isDiscordHiccup,
  hiccupText,
  truncate,
  ordinal,
  fillTemplate,
  chunkText,
  shortId,
  parseMessageRef,
  messageUrl,
  channelUrl,
  parseEmoji,
  emojiKey,
  emojiText,
  emojiComponent,
  stripVariation,
  botRoleProblem,
  selfAssignProblem,
  assertBotChannelPerms,
  fileKind,
  safeFileName,
  formatBytes,
  download,
  downloadAttachments,
};
