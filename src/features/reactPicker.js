'use strict';
const crypto = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonStyle,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const config = require('../config');
const ui = require('../lib/ui');
const { UserError, truncate, emojiKey, emojiText, parseMessageRef, assertBotChannelPerms } = require('../lib/utils');
const autoReact = require('./autoReact');

/**
 * 😀 Emoji picker: a clickable list of the server's emojis, animated ones included. Typing animated emojis
 * needs Nitro, but the bot can show them in its menus to everyone.
 *
 * Used by:
 * - /react message:<ID or link>, and right-click a message → Apps → React as Bot:
 *   the bot reacts to that one message (the picker starts with the bot's current reactions ticked;
 *   untick one to take it off).
 * - /autoreact set channel:#x with the emojis box left empty: saves the channel's auto reactions.
 *
 * One picker = one private message with up to 4 dropdowns of 25 emojis (100 per page), A→Z, plus
 * page buttons and a search for big servers. Emojis are added in the order they're ticked.
 */

const PER_SELECT = 25; // Discord's limit of options in one dropdown
const SELECTS_PER_PAGE = 4;
const PER_PAGE = PER_SELECT * SELECTS_PER_PAGE;
const MAX = 20; // different reactions on one message
const TTL = 30 * 60 * 1000;

const sessions = new Map();
setInterval(() => {
  const cutoff = Date.now() - TTL;
  for (const [sid, s] of sessions) if (s.createdAt < cutoff) sessions.delete(sid);
}, 5 * 60 * 1000).unref();

function newSession(interaction, data) {
  const sid = crypto.randomBytes(5).toString('hex');
  const s = { sid, userId: interaction.user.id, guildId: interaction.guildId, createdAt: Date.now(), page: 0, query: '', chosen: [], note: null, slots: [], ...data };
  sessions.set(sid, s);
  return s;
}

function sessionFor(interaction, sid) {
  const s = sessions.get(sid);
  if (!s) throw new UserError('This emoji list expired (they last 30 minutes). Run the command again.', 'List expired');
  if (s.userId !== interaction.user.id) throw new UserError('This emoji list belongs to someone else.', 'Not yours');
  s.note = null;
  return s;
}

const listText = (emojis) => emojis.map(emojiText).join(' ');
const plain = (e) => ({ id: e.id ?? null, name: e.name, animated: Boolean(e.animated) });

/** The server's emojis the bot can react with, A→Z (and how many it can't use). */
function serverEmojis(guild) {
  const usable = [];
  let hidden = 0;
  for (const e of guild.emojis.cache.values()) {
    if (autoReact.customEmojiProblem(guild, e)) hidden++;
    else usable.push(plain(e));
  }
  usable.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id));
  return { usable, hidden };
}

/* ───────────────────────── the picker message ───────────────────────── */

function header(guild, s) {
  if (s.mode === 'channel') {
    const posts = autoReact.POST_CHANNELS.has(guild.channels.cache.get(s.channelId)?.type);
    return `## 😀 Auto reactions for <#${s.channelId}>\nTick the emojis every new ${posts ? 'post' : 'message'} there should get. They’re added in the order you tick them.`;
  }
  const by = s.authorId ? ` by <@${s.authorId}>` : '';
  return `## 😀 React to a message\n[Open the message](${s.url})${by} · tick the emojis I should react with${s.initial ? ', untick one to take my reaction off' : ''}.`;
}

function chosenText(s) {
  const head = s.chosen.length
    ? `**Chosen ${s.chosen.length}/${MAX}** · in this order\n${listText(s.chosen)}`
    : s.mode === 'message' && s.initial
      ? '**Nothing ticked.** Confirm to take all my reactions off this message.'
      : '**Nothing chosen yet.** Open a list below and tick your emojis.';
  return s.note ? `${head}\n-# ⚠️ ${truncate(s.note, 600)}` : head;
}

function confirmButton(s) {
  if (s.mode === 'channel') return { label: `Save (${s.chosen.length})`, disabled: !s.chosen.length };
  if (!s.chosen.length) return { label: 'Remove my reactions', disabled: !s.initial };
  return { label: `React (${s.chosen.length})`, disabled: false };
}

function render(guild, s) {
  const { usable, hidden } = serverEmojis(guild);
  const list = s.query ? usable.filter((e) => e.name.toLowerCase().includes(s.query)) : usable;
  const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
  s.page = Math.min(Math.max(0, Number(s.page) || 0), pages - 1);
  const items = list.slice(s.page * PER_PAGE, (s.page + 1) * PER_PAGE);
  const ticked = new Set(s.chosen.map(emojiKey));

  const c = ui.container(config.brand.color);
  c.addTextDisplayComponents(ui.text(header(guild, s)), ui.text(chosenText(s)));
  c.addSeparatorComponents(ui.divider());
  s.slots = [];
  for (let i = 0; i < items.length; i += PER_SELECT) {
    const chunk = items.slice(i, i + PER_SELECT);
    const slot = s.slots.push(chunk.map((e) => e.id)) - 1;
    const range = chunk.length > 1 ? `${chunk[0].name} → ${chunk.at(-1).name}` : chunk[0].name;
    c.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`ep:s:${s.sid}:${slot}`)
          .setPlaceholder(truncate(`😀 ${range}`, 150))
          .setMinValues(0)
          .setMaxValues(chunk.length)
          .addOptions(chunk.map((e) => ({ label: e.name, value: e.id, emoji: { id: e.id, name: e.name, animated: e.animated }, default: ticked.has(e.id) }))),
      ),
    );
  }
  const info = [];
  if (!usable.length) info.push('This server has no custom emojis I can use yet. Use **⌨️ Type** for normal emojis');
  else if (!list.length) info.push(`No emoji name contains “${s.query}”`);
  else info.push(`${pages > 1 ? `Page ${s.page + 1}/${pages} · ` : ''}${list.length} emoji${list.length === 1 ? '' : 's'}${s.query ? ` matching “${s.query}”` : ''} · A→Z`);
  if (hidden) info.push(`${hidden} hidden (limited to roles I don’t have, or unavailable)`);
  c.addTextDisplayComponents(ui.text(`-# ${info.join(' · ')}`));
  c.addSeparatorComponents(ui.divider());

  const nav = [];
  if (pages > 1) {
    nav.push(ui.button({ id: `ep:p:${s.sid}:${s.page - 1}:prev`, label: 'Previous', emoji: '◀️', disabled: s.page === 0 }));
    nav.push(ui.button({ id: `ep:p:${s.sid}:${s.page + 1}:next`, label: 'Next', emoji: '▶️', disabled: s.page >= pages - 1 }));
  }
  if (s.query) nav.push(ui.button({ id: `ep:fc:${s.sid}`, label: 'Clear search', emoji: '✖️' }));
  else if (usable.length > PER_SELECT) nav.push(ui.button({ id: `ep:f:${s.sid}`, label: 'Search', emoji: '🔍' }));
  if (nav.length) c.addActionRowComponents(ui.row(nav));
  const ok = confirmButton(s);
  c.addActionRowComponents(
    ui.row(
      ui.button({ id: `ep:ok:${s.sid}`, label: ok.label, emoji: '✅', style: ButtonStyle.Success, disabled: ok.disabled }),
      ui.button({ id: `ep:t:${s.sid}`, label: 'Type', emoji: '⌨️' }),
      ui.button({ id: `ep:c:${s.sid}`, label: 'Clear', emoji: '🗑️', disabled: !s.chosen.length }),
      ui.button({ id: `ep:x:${s.sid}`, label: 'Cancel', style: ButtonStyle.Danger }),
    ),
  );
  return { components: [c], flags: ui.V2, allowedMentions: { parse: [] } };
}

/** Adds emojis to the end of the chosen list (no duplicates, at most MAX). Returns how many didn't fit. */
function addChosen(s, emojis) {
  const have = new Set(s.chosen.map(emojiKey));
  let skipped = 0;
  for (const e of emojis) {
    if (have.has(emojiKey(e))) continue;
    if (s.chosen.length >= MAX) {
      skipped++;
      continue;
    }
    s.chosen.push(plain(e));
    have.add(emojiKey(e));
  }
  return skipped;
}

const tooMany = (n) => `Discord allows ${MAX} different reactions per message, so ${n} more couldn’t be added.`;

/* ───────────────────────── opening a picker ───────────────────────── */

function openForChannel(interaction, channel, { chosen = [], bots = true } = {}) {
  const s = newSession(interaction, { mode: 'channel', channelId: channel.id, bots, chosen: chosen.map(plain) });
  return ui.respond(interaction, render(interaction.guild, s));
}

/** The reactions the bot itself has on a message. */
function botReactions(message) {
  return [...(message.reactions?.cache?.values() ?? [])].filter((r) => r.me).map((r) => ({ reaction: r, emoji: plain(r.emoji) }));
}

function openForMessage(interaction, message) {
  const chosen = botReactions(message).map((r) => r.emoji);
  const s = newSession(interaction, {
    mode: 'message',
    channelId: message.channelId,
    messageId: message.id,
    url: message.url,
    authorId: message.author?.id ?? null,
    chosen,
    initial: chosen.length,
  });
  return ui.respond(interaction, render(interaction.guild, s));
}

/* ───────────────────────── finding the message ───────────────────────── */

/**
 * Finds a message from its link, "channelID-messageID", or just its ID. With only an ID: the chosen
 * channel, else this channel, else every channel and thread the bot can read.
 */
async function findMessage(interaction, input, channelOption = null) {
  const ref = parseMessageRef(input);
  if (!ref) {
    throw new UserError('Paste the message **ID** or **link**: right-click the message → **Copy Message ID** (or **Copy Message Link**).', 'Which message?');
  }
  if (ref.guildId && ref.guildId !== interaction.guildId) throw new UserError('That message is in a different server.');
  const guild = interaction.guild;
  const me = guild.members.me;
  const lookIn = async (channel) => {
    if (!channel?.messages?.fetch || channel.isTextBased?.() === false) return null;
    const perms = channel.permissionsFor?.(me);
    if (perms && !perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) return null;
    return channel.messages.fetch({ message: ref.messageId, force: true }).catch(() => null);
  };
  const channelId = ref.channelId ?? channelOption?.id;
  if (channelId) {
    const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
    const found = await lookIn(channel);
    if (found) return found;
    throw new UserError(`I couldn’t find that message in ${channel ?? 'that channel'}, or I can’t read that channel.`, 'Message not found');
  }
  const here = await lookIn(interaction.channel);
  if (here) return here;
  const others = [...guild.channels.cache.values()].filter((ch) => ch.id !== interaction.channelId && ch.messages?.fetch);
  for (let i = 0; i < others.length; i += 5) {
    const found = (await Promise.all(others.slice(i, i + 5).map(lookIn))).find(Boolean);
    if (found) return found;
  }
  throw new UserError(
    'No channel I can read has a message with that ID. Check the ID, or paste the message **link** instead (right-click the message → **Copy Message Link**).',
    'Message not found',
  );
}

/* ───────────────────────── reacting ───────────────────────── */

/**
 * Makes the bot's reactions on a message match `want` (exact = also take off the bot's other reactions),
 * adding new ones in order.
 */
async function applyReactions(guild, message, want, { exact }) {
  const botId = guild.client.user.id;
  const mine = botReactions(message);
  const wantKeys = new Set(want.map(emojiKey));
  const mineKeys = new Set(mine.map((r) => emojiKey(r.emoji)));
  const result = { added: [], removed: [], failed: [], stop: null };
  for (const e of want.filter((x) => !mineKeys.has(emojiKey(x)))) {
    try {
      await message.react(e.id ? emojiText(e) : e.name);
      result.added.push(e);
    } catch (err) {
      if (err?.code === 10014) {
        result.failed.push(e); // deleted, or not usable by the bot
        continue;
      }
      if (err?.code === 30010) {
        result.stop = `The message already has ${MAX} different reactions, Discord’s limit.`;
        break;
      }
      if (err?.code === 90001) {
        result.stop = 'The author of the message has blocked me, so Discord won’t let me react.';
        break;
      }
      if (err?.code === 10008) throw new UserError('That message was deleted.', 'Message deleted');
      if (err?.code === 50013 || err?.code === 50001) {
        const external = e.id && !guild.emojis.cache.has(e.id) ? ', plus **Use External Emoji**' : '';
        throw new UserError(`I’m not allowed to react in ${message.channel}. Give my role **Add Reactions** and **Read Message History** there${external}.`, 'Missing permission');
      }
      throw err;
    }
  }
  if (exact) {
    for (const r of mine.filter((x) => !wantKeys.has(emojiKey(x.emoji)))) {
      try {
        await r.reaction.users.remove(botId);
        result.removed.push(r.emoji);
      } catch {
        result.failed.push(r.emoji);
      }
    }
  }
  return result;
}

function resultCard(result, url) {
  const lines = [];
  if (result.added.length) lines.push(`Added ${listText(result.added)}`);
  if (result.removed.length) lines.push(`Took off ${listText(result.removed)}`);
  if (!result.added.length && !result.removed.length && !result.stop && !result.failed.length) {
    lines.push('Nothing to change: the message already has exactly these reactions from me.');
  }
  if (result.failed.length) lines.push(`-# Couldn’t use ${listText(result.failed)} (deleted, or not allowed).`);
  if (result.stop) lines.push(`-# ⚠️ ${result.stop}`);
  const tone = result.stop || result.failed.length ? 'warn' : 'success';
  return ui.notice(tone, 'Reactions updated', lines.join('\n'), { buttons: [ui.button({ label: 'Open message', emoji: '🔗', url })] });
}

/* ───────────────────────── commands ───────────────────────── */

/** /react message:<ID or link> [emojis] [channel] */
async function command(interaction) {
  const guild = interaction.guild;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral }); // searching every channel can take a moment
  const message = await findMessage(interaction, interaction.options.getString('message', true), interaction.options.getChannel('channel'));
  assertBotChannelPerms(message.channel, ['ViewChannel', 'ReadMessageHistory', 'AddReactions']);
  const typed = interaction.options.getString('emojis');
  if (!typed) return openForMessage(interaction, message);
  const { emojis, problems } = await autoReact.parseEmojiList(typed, guild);
  if (problems.length) {
    throw new UserError(`${problems.slice(0, 8).map((p) => `• ${p}`).join('\n')}\n-# Tip: leave **emojis** empty to pick from a list instead.`, 'Some of those can’t be used');
  }
  if (!emojis.length) throw new UserError('Add at least one emoji, or leave **emojis** empty to pick from a list.', 'No emojis');
  if (emojis.length > MAX) throw new UserError(`A message can have at most ${MAX} different reactions.`, 'Too many emojis');
  const result = await applyReactions(guild, message, emojis, { exact: false });
  return ui.respond(interaction, resultCard(result, message.url));
}

/** Right-click a message → Apps → React as Bot */
async function reactAsBot(interaction) {
  const target = interaction.targetMessage;
  assertBotChannelPerms(target.channel, ['ViewChannel', 'ReadMessageHistory', 'AddReactions']);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  // fresh copy: the reactions on it must be current
  const message = (await target.channel.messages.fetch({ message: target.id, force: true }).catch(() => null)) ?? target;
  return openForMessage(interaction, message);
}

/* ───────────────────────── buttons, lists & forms ───────────────────────── */

function searchModal(s) {
  return new ModalBuilder()
    .setCustomId(`ep:fm:${s.sid}`)
    .setTitle('Search emojis')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Name contains')
        .setDescription('Part of the emoji name, e.g. fire, gg, party')
        .setTextInputComponent(new TextInputBuilder().setCustomId('q').setStyle(TextInputStyle.Short).setMaxLength(32).setRequired(true)),
    );
}

function typeModal(s) {
  return new ModalBuilder()
    .setCustomId(`ep:tm:${s.sid}`)
    .setTitle('Type emojis')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Emojis')
        .setDescription('Normal emojis (🔥 👍) or server emoji names (:gg:), separated by spaces')
        .setTextInputComponent(
          new TextInputBuilder().setCustomId('emojis').setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true).setPlaceholder('🔥 👍 :gg:'),
        ),
    );
}

async function confirm(interaction, s) {
  const guild = interaction.guild;
  if (s.mode === 'channel') {
    const channel = guild.channels.cache.get(s.channelId) ?? (await guild.channels.fetch(s.channelId).catch(() => null));
    if (!channel) throw new UserError('That channel no longer exists.', 'Channel deleted');
    const payload = autoReact.saveChannel(guild, channel, s.chosen, s.bots);
    sessions.delete(s.sid);
    return ui.updateMessage(interaction, payload);
  }
  // reacting takes a moment (Discord allows about 4 reactions a second)
  await ui.deferUpdate(interaction);
  const channel = guild.channels.cache.get(s.channelId) ?? (await guild.channels.fetch(s.channelId).catch(() => null));
  const message = await channel?.messages?.fetch({ message: s.messageId, force: true }).catch(() => null);
  if (!message) throw new UserError('That message was deleted, or I can’t see its channel any more.', 'Message not found');
  const result = await applyReactions(guild, message, s.chosen, { exact: true });
  sessions.delete(s.sid);
  return ui.updateMessage(interaction, resultCard(result, message.url));
}

async function onComponent(interaction) {
  const [, action, sid, arg] = interaction.customId.split(':');
  const s = sessionFor(interaction, sid);
  const guild = interaction.guild;
  switch (action) {
    case 's': {
      // a dropdown changed: unticked → off the list, newly ticked → added at the end
      const slot = s.slots[Number(arg)] ?? [];
      const picked = new Set(interaction.values);
      s.chosen = s.chosen.filter((e) => !(e.id && slot.includes(e.id) && !picked.has(e.id)));
      const fresh = slot.filter((id) => picked.has(id)).map((id) => guild.emojis.cache.get(id)).filter(Boolean);
      const skipped = addChosen(s, fresh);
      if (skipped) s.note = tooMany(skipped);
      return ui.updateMessage(interaction, render(guild, s));
    }
    case 'p':
      s.page = Number(arg);
      return ui.updateMessage(interaction, render(guild, s));
    case 'f':
      return interaction.showModal(searchModal(s));
    case 'fc':
      s.query = '';
      s.page = 0;
      return ui.updateMessage(interaction, render(guild, s));
    case 't':
      return interaction.showModal(typeModal(s));
    case 'c':
      s.chosen = [];
      return ui.updateMessage(interaction, render(guild, s));
    case 'x':
      sessions.delete(sid);
      return ui.updateMessage(interaction, ui.notice('info', 'Cancelled', 'Nothing was changed.'));
    case 'ok':
      return confirm(interaction, s);
    default:
      throw new UserError('Unknown button.');
  }
}

async function onModal(interaction) {
  const [, action, sid] = interaction.customId.split(':');
  const s = sessionFor(interaction, sid);
  const guild = interaction.guild;
  if (action === 'fm') {
    s.query = interaction.fields.getTextInputValue('q').replace(/:/g, '').trim().toLowerCase();
    s.page = 0;
    return ui.updateMessage(interaction, render(guild, s));
  }
  if (action === 'tm') {
    const { emojis, problems } = await autoReact.parseEmojiList(interaction.fields.getTextInputValue('emojis'), guild);
    const skipped = addChosen(s, emojis);
    const notes = [];
    if (problems.length) notes.push(`Couldn’t use: ${problems.slice(0, 3).join(' · ')}${problems.length > 3 ? ` · …and ${problems.length - 3} more` : ''}`);
    if (skipped) notes.push(tooMany(skipped));
    s.note = notes.join(' · ') || null;
    return ui.updateMessage(interaction, render(guild, s));
  }
  throw new UserError('Unknown form.');
}

module.exports = {
  command,
  reactAsBot,
  onComponent,
  onModal,
  openForChannel,
  findMessage,
  render,
  newSession,
  PER_PAGE,
  MAX,
};
