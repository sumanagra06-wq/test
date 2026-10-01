'use strict';
const { ChannelType, MessageType } = require('discord.js');
const config = require('../config');
const store = require('../lib/store');
const log = require('../lib/log');
const ui = require('../lib/ui');
const { UserError, truncate, emojiKey, emojiText, stripVariation, assertBotChannelPerms, isDiscordHiccup, hiccupText } = require('../lib/utils');

/**
 * ✨ Auto reactions: in the channels you pick, the bot reacts to every new message with your emojis, in your order.
 *
 * - Messages from members, other bots and webhooks are handled as they arrive (onMessage).
 * - The bot's own posts call reactToOwnPost(): announcements (only their last part, so a split announcement
 *   still reads as one post) and welcome messages. Role panels are left alone, so their reactions stay meaningful.
 * - Forum and media channels: the first message of every new post.
 * - One message at a time per channel (Discord allows about 4 reactions a second per channel), so the
 *   reactions always appear in your order.
 */

const MAX_EMOJIS = 20; // Discord's limit of different reactions on one message
const MAX_BACKLOG = 50; // per channel: beyond this, new messages are skipped until the bot has caught up
const WARN_EVERY = 60 * 60 * 1000; // the same problem is logged at most once an hour
const PICK_TIP = 'Tip: leave **emojis** empty to pick from a list of your server’s emojis (animated ones too).';

/** Chat messages, replies, other bots' command replies, joins and boosts. Not pins, thread notices and the like. */
const REACTABLE = new Set([
  MessageType.Default,
  MessageType.Reply,
  MessageType.ChatInputCommand,
  MessageType.ContextMenuCommand,
  MessageType.UserJoin,
  MessageType.GuildBoost,
  MessageType.GuildBoostTier1,
  MessageType.GuildBoostTier2,
  MessageType.GuildBoostTier3,
]);
/** Channels made of posts: the bot reacts to the first message of each new post. */
const POST_CHANNELS = new Set([ChannelType.GuildForum, ChannelType.GuildMedia]);

/* ───────────────────────── reading the emoji list ───────────────────────── */

// custom emoji · :name: · emoji ID · Unicode emoji (skin tones, flags, keycaps, ZWJ…) · bare name · anything else
const TOKEN_RE = /<(a?):([\w~]{1,32}):(\d{15,21})>|:([\w~]{2,32}):|(\d{15,21})|(\p{RGI_Emoji}|\p{Extended_Pictographic}\uFE0F?)|([\w~]{2,32})|([^\s,;])/gv;

const RGI_EMOJI = /^\p{RGI_Emoji}$/v;
/** "❤" → "❤️": Discord only accepts the fully-qualified form of emoji that need the variation selector. */
function qualify(unicode) {
  if (RGI_EMOJI.test(unicode)) return unicode;
  const withSelector = `${stripVariation(unicode)}\uFE0F`;
  return RGI_EMOJI.test(withSelector) ? withSelector : unicode;
}

/** Why the bot can't react with this custom emoji, or null if it can. */
function customEmojiProblem(guild, e) {
  if (e.available === false) return `\`:${e.name}:\` is unavailable right now (the server lost the boost level it needs)`;
  const allowed = e.roles?.cache;
  if (allowed?.size) {
    const mine = (e.guild ?? guild).members?.me?.roles?.cache;
    if (!mine || ![...allowed.keys()].some((id) => mine.has(id))) {
      return `\`:${e.name}:\` is limited to certain roles. Give my role access to it, or pick another emoji`;
    }
  }
  return null;
}

/**
 * Reads the emojis typed or picked in the command box, e.g. "<:gg:123…> :hype: 🔥 👍".
 * Names are looked up in this server; custom emojis given by ID/tag may also come from another server the bot is in.
 * Duplicates are dropped and the order is kept.
 * @returns {Promise<{ emojis: Array<{id: string|null, name: string, animated: boolean}>, problems: string[] }>}
 */
async function parseEmojiList(input, guild) {
  let refreshed = false;
  const lookup = async (find) => {
    let e = find();
    if (!e && !refreshed) {
      refreshed = true; // a brand-new emoji may not be cached yet
      await guild.emojis.fetch?.().catch(() => null);
      e = find();
    }
    return e ?? null;
  };
  const byId = (id) => lookup(() => guild.emojis.cache.get(id) ?? guild.client?.emojis?.cache?.get(id));
  const byName = (name) =>
    lookup(() => guild.emojis.cache.find((e) => e.name === name) ?? guild.emojis.cache.find((e) => e.name?.toLowerCase() === name.toLowerCase()));

  const emojis = [];
  const problems = [];
  const junk = new Set();
  const seen = new Set();
  for (const m of String(input ?? '').matchAll(TOKEN_RE)) {
    const [, , tagName, tagId, colonName, rawId, unicode, bare, other] = m;
    if (other !== undefined) {
      junk.add(other);
      continue;
    }
    let emoji;
    if (unicode !== undefined) emoji = { id: null, name: qualify(unicode), animated: false };
    else {
      const id = tagId ?? rawId;
      const e = id ? await byId(id) : await byName(colonName ?? bare);
      if (!e) {
        if (tagId) problems.push(`\`:${tagName}:\` is from a server I’m not in. Use this server’s emojis`);
        else if (rawId) problems.push(`No emoji with the ID \`${rawId}\` in this server`);
        else if (colonName) problems.push(`This server has no emoji called \`:${colonName}:\``);
        else problems.push(`\`${truncate(bare, 40)}\` isn’t an emoji or the name of one of this server’s emojis`);
        continue;
      }
      const problem = customEmojiProblem(guild, e);
      if (problem) {
        problems.push(problem);
        continue;
      }
      emoji = { id: e.id, name: e.name, animated: Boolean(e.animated) };
    }
    const key = emojiKey(emoji);
    if (seen.has(key)) continue;
    seen.add(key);
    emojis.push(emoji);
  }
  if (junk.size) problems.push(`Not emojis: ${[...junk].map((c) => `\`${c}\``).join(' ')}`);
  return { emojis, problems };
}

/** Finds an emoji on a channel's list from what was typed/picked (ID, <:name:id>, :name:, name or the emoji itself). */
function findStored(list, input) {
  const s = String(input ?? '').trim();
  const id = s.match(/^<a?:[\w~]+:(\d{15,21})>$/)?.[1] ?? (/^\d{15,21}$/.test(s) ? s : null);
  if (id) return list.find((e) => e.id === id) ?? null;
  const name = s.replace(/^:|:$/g, '').toLowerCase();
  return (
    list.find((e) => (e.id ? e.name.toLowerCase() === name : stripVariation(e.name) === stripVariation(s))) ?? null
  );
}

/* ───────────────────────── /autoreact ───────────────────────── */

const listText = (emojis) => emojis.map(emojiText).join(' ');

function listCard(guild) {
  const cmd = (name) => ui.cmd(guild.id, name);
  const entries = Object.entries(store.guild(guild.id).autoReact).filter(([, c]) => c.emojis?.length);
  if (!entries.length) {
    return ui.notice('info', 'No auto reactions yet', `Pick a channel and your emojis with ${cmd('autoreact set')}. I’ll react to every new message there.`);
  }
  const blocks = [];
  let used = 0;
  for (const [channelId, c] of entries) {
    const channel = guild.channels.cache.get(channelId);
    const kind = channel && POST_CHANNELS.has(channel.type) ? ' · new posts' : '';
    const block = `**<#${channelId}>**${kind} · ${c.bots === false ? '👤 members only' : '🤖 bots too'}\n${listText(c.emojis)}`;
    if (used + block.length > 3200) {
      blocks.push(`-# …and ${entries.length - blocks.length} more channel(s)`);
      break;
    }
    blocks.push(block);
    used += block.length + 2;
  }
  const card = ui
    .container(config.brand.color)
    .addTextDisplayComponents(ui.text(`## ✨ Auto reactions\n${blocks.join('\n\n')}`))
    .addSeparatorComponents(ui.divider())
    .addTextDisplayComponents(
      ui.text(`-# I react to every new message in these channels, in this order · ${cmd('autoreact set')} · ${cmd('autoreact add')} · ${cmd('autoreact remove')}`),
    );
  return { components: [card], flags: ui.V2, allowedMentions: { parse: [] } };
}

/**
 * Saves a channel's emoji list (after checking the limit and the bot's permissions there)
 * and returns the confirmation card. Used by typed emojis and by the clickable list.
 */
function saveChannel(guild, channel, list, bots, { title = 'Auto reactions on', note = null } = {}) {
  if (!list.length) throw new UserError(`Add at least one emoji. ${PICK_TIP}`, 'No emojis');
  if (list.length > MAX_EMOJIS) {
    throw new UserError(`A message can have at most ${MAX_EMOJIS} different reactions. That would be ${list.length}.`, 'Too many emojis');
  }
  const perms = ['ViewChannel', 'ReadMessageHistory', 'AddReactions'];
  if (list.some((e) => e.id && !guild.emojis.cache.has(e.id))) perms.push('UseExternalEmojis');
  assertBotChannelPerms(channel, perms);
  const g = store.guild(guild.id);
  g.autoReact[channel.id] = { emojis: list.map(({ id, name, animated }) => ({ id: id ?? null, name, animated: Boolean(animated) })), bots, updatedAt: Date.now() };
  store.save(guild.id);
  const lines = [
    `${channel}: every new ${POST_CHANNELS.has(channel.type) ? 'post' : 'message'} gets`,
    `## ${listText(list)}`,
    `-# In this order · ${bots ? '🤖 bot messages too' : '👤 members’ messages only'} · messages that are already there aren’t touched`,
    note ? `-# ${note}` : null,
    list.length > 8 ? `-# Discord adds about 4 reactions a second, so ${list.length} emojis take a few seconds per message.` : null,
  ];
  return ui.notice('success', title, lines.filter(Boolean).join('\n'));
}

async function command(interaction) {
  const guild = interaction.guild;
  const g = store.guild(guild.id);
  const sub = interaction.options.getSubcommand();

  if (sub === 'set' || sub === 'add') {
    const channel = interaction.options.getChannel('channel', true);
    const current = g.autoReact[channel.id];
    const typed = interaction.options.getString('emojis');
    if (!typed) {
      // no emojis typed → a clickable list of the server's emojis (animated ones work without Nitro)
      assertBotChannelPerms(channel, ['ViewChannel', 'ReadMessageHistory', 'AddReactions']);
      const bots = interaction.options.getBoolean('bots') ?? current?.bots ?? true;
      return require('./reactPicker').openForChannel(interaction, channel, { chosen: current?.emojis ?? [], bots });
    }
    const { emojis, problems } = await parseEmojiList(typed, guild);
    if (problems.length) {
      const shown = problems.slice(0, 8).map((p) => `• ${p}`);
      if (problems.length > 8) shown.push(`• …and ${problems.length - 8} more`);
      throw new UserError(`${shown.join('\n')}\n-# ${PICK_TIP}`, 'Some of those can’t be used');
    }
    if (!emojis.length) throw new UserError(`Add at least one emoji. ${PICK_TIP}`, 'No emojis');
    const before = sub === 'add' && current ? current.emojis : [];
    const known = new Set(before.map(emojiKey));
    const added = emojis.filter((e) => !known.has(emojiKey(e)));
    if (!added.length) return ui.respond(interaction, ui.notice('info', 'Already on the list', `${channel} already reacts with ${listText(before)}`));
    const bots = interaction.options.getBoolean('bots') ?? current?.bots ?? true;
    const note = sub === 'add' && added.length < emojis.length ? `${emojis.length - added.length} of them were already on the list.` : null;
    return ui.respond(interaction, saveChannel(guild, channel, [...before, ...added], bots, { title: sub === 'add' ? 'Emojis added' : 'Auto reactions on', note }));
  }

  if (sub === 'remove') {
    const channel = interaction.options.getChannel('channel', true);
    const cfg = g.autoReact[channel.id];
    if (!cfg) throw new UserError(`${channel} has no auto reactions.`, 'Nothing to remove');
    const input = interaction.options.getString('emoji')?.trim();
    if (!input) {
      delete g.autoReact[channel.id];
      store.save(guild.id);
      return ui.respond(interaction, ui.notice('success', 'Auto reactions off', `I’ll stop reacting in ${channel}. Reactions I already added stay.`));
    }
    const target = findStored(cfg.emojis, input);
    if (!target) throw new UserError(`That emoji isn’t on ${channel}’s list. Pick one from the suggestions.`, 'Not on the list');
    cfg.emojis = cfg.emojis.filter((e) => e !== target);
    cfg.updatedAt = Date.now();
    if (!cfg.emojis.length) delete g.autoReact[channel.id];
    store.save(guild.id);
    const rest = cfg.emojis.length ? `Still reacting with ${listText(cfg.emojis)}` : 'That was the last one, so auto reactions are now off there.';
    return ui.respond(interaction, ui.notice('success', 'Emoji removed', `${emojiText(target)} is off ${channel}’s list.\n-# ${rest}`));
  }

  if (sub === 'list') return ui.respond(interaction, listCard(guild));
  throw new UserError('Unknown option.');
}

/** Autocomplete for `/autoreact remove emoji:` (the emojis on the chosen channel's list). */
function emojiChoices(guild, channelId, query) {
  const cfg = channelId ? store.guild(guild.id).autoReact[channelId] : null;
  if (!cfg) return [];
  const q = String(query || '').replace(/:/g, '').trim().toLowerCase();
  return cfg.emojis
    .map((e) => ({ name: e.id ? `:${e.name}:${e.animated ? ' (animated)' : ''}` : e.name, value: e.id ?? e.name }))
    .filter((c) => !q || c.name.toLowerCase().includes(q) || c.value === query)
    .slice(0, 25);
}

/* ───────────────────────── reacting ───────────────────────── */

const queues = new Map(); // channelId → { tail: Promise, size }
const warned = new Map(); // problem → last time it was logged

function warnOnce(key, message) {
  if (Date.now() - (warned.get(key) ?? 0) < WARN_EVERY) return;
  warned.set(key, Date.now());
  log.warn(message);
}

const channelName = (message) => message.channel?.name ?? message.channelId;

function configFor(message) {
  const map = store.guilds[message.guildId]?.autoReact;
  if (!map) return null;
  let cfg = map[message.channelId];
  // the first message of a forum/media post has the same ID as the post itself
  if (!cfg && message.id === message.channelId && message.channel?.parentId) cfg = map[message.channel.parentId];
  return cfg?.emojis?.length ? cfg : null;
}

/** Removes an emoji that was deleted from the server from every channel's list. */
function forgetEmoji(guildId, emoji) {
  const map = store.guilds[guildId]?.autoReact;
  if (!map || !emoji?.id) return;
  let changed = 0;
  for (const [channelId, cfg] of Object.entries(map)) {
    const before = cfg.emojis.length;
    cfg.emojis = cfg.emojis.filter((e) => e.id !== emoji.id);
    if (cfg.emojis.length === before) continue;
    changed++;
    if (!cfg.emojis.length) delete map[channelId];
  }
  if (!changed) return;
  store.save(guildId);
  log.warn(`Auto reactions: the emoji :${emoji.name}: was deleted from the server, so I took it off ${changed} channel list(s).`);
}

async function reactAll(message, emojis) {
  for (const emoji of emojis) {
    try {
      await message.react(emoji.id ? emojiText(emoji) : emoji.name);
    } catch (err) {
      switch (err?.code) {
        case 10014: // Unknown Emoji: a custom emoji was deleted from the server
          if (emoji.id) forgetEmoji(message.guildId, emoji);
          else warnOnce(`emoji:${emoji.name}`, `Auto reactions: Discord doesn’t accept ${emoji.name} as a reaction. Remove it with /autoreact remove.`);
          continue;
        case 10003: // Unknown Channel
        case 10008: // Unknown Message: deleted before I got to it
        case 30010: // the message already has 20 different reactions
        case 50083: // the thread is archived
        case 90001: // reaction blocked (the author blocked the bot)
          return;
        case 50001:
        case 50013:
          return warnOnce(
            `perm:${message.channelId}`,
            `Auto reactions: I can’t react in #${channelName(message)}. Give my role View Channel, Read Message History and Add Reactions there` +
              `${emoji.id ? ' (plus Use External Emoji for emojis from other servers)' : ''}.`,
          );
        default:
          if (isDiscordHiccup(err)) return warnOnce('hiccup', `Auto reactions skipped a message: Discord had a temporary problem (${hiccupText(err)}).`);
          return warnOnce(`fail:${message.channelId}:${err?.code ?? err?.message}`, `Auto reactions failed in #${channelName(message)}: ${err?.message ?? err}`);
      }
    }
  }
}

/** Queues the reactions for a message (one message at a time per channel, so they appear in order). */
function enqueue(message) {
  const cfg = configFor(message);
  if (!cfg) return null;
  if (!REACTABLE.has(message.type ?? MessageType.Default)) return null;
  if (cfg.bots === false && (message.author?.bot || message.webhookId)) return null;
  const channelId = message.channelId;
  let q = queues.get(channelId);
  if (!q) queues.set(channelId, (q = { tail: Promise.resolve(), size: 0 }));
  if (q.size >= MAX_BACKLOG) {
    warnOnce(
      `busy:${channelId}`,
      `Auto reactions: #${channelName(message)} gets messages faster than Discord lets me react (about 4 reactions a second), so I’m skipping some until I catch up.`,
    );
    return null;
  }
  q.size++;
  const emojis = cfg.emojis.slice();
  q.tail = q.tail
    .then(() => reactAll(message, emojis))
    .catch((err) => log.warn('Auto reactions failed:', err?.message ?? err))
    .finally(() => {
      q.size--;
      if (!q.size && queues.get(channelId) === q) queues.delete(channelId);
    });
  return q.tail;
}

/** New message from a member, another bot or a webhook. The bot's own posts go through reactToOwnPost. */
function onMessage(message) {
  if (!message?.guildId) return null;
  const botId = message.client?.user?.id ?? message.guild?.client?.user?.id;
  if (message.author?.id === botId) return null;
  return enqueue(message);
}

/** Called right after the bot posts an announcement (its last part) or a welcome message. */
function reactToOwnPost(message) {
  return message?.guildId ? enqueue(message) : null;
}

function onEmojiDelete(emoji) {
  if (emoji?.guild) forgetEmoji(emoji.guild.id, emoji);
}

function onChannelDelete(channel) {
  const map = channel?.guild && store.guilds[channel.guild.id]?.autoReact;
  if (map?.[channel.id]) {
    delete map[channel.id];
    store.save(channel.guild.id);
  }
}

/** Resolves once every queued reaction is done (used by the tests). */
async function idle() {
  while (queues.size) await Promise.all([...queues.values()].map((q) => q.tail));
}

module.exports = {
  command,
  saveChannel,
  customEmojiProblem,
  POST_CHANNELS,
  emojiChoices,
  listCard,
  parseEmojiList,
  onMessage,
  reactToOwnPost,
  onEmojiDelete,
  onChannelDelete,
  idle,
  MAX_EMOJIS,
  MAX_BACKLOG,
};
