'use strict';
const crypto = require('node:crypto');
const { ActionRowBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, PermissionFlagsBits, StringSelectMenuBuilder, escapeMarkdown } = require('discord.js');
const config = require('../config');
const store = require('../lib/store');
const ui = require('../lib/ui');
const { UserError, truncate, emojiKey, emojiText } = require('../lib/utils');
const autoReact = require('./autoReact');

/**
 * 📋 Emoji templates & copying: one emoji list for many channels.
 *
 * - /autoreact template create name:<name> [from:#channel]: a named emoji list, picked from the emoji list or
 *   copied from a channel (that channel then follows the template too).
 * - /autoreact template apply: put a template on many channels at once (pick channels, whole categories, or every
 *   chat channel). Those channels *follow* it: /autoreact template edit changes all of them in one go.
 * - /autoreact copy from:#channel: copy one channel's emojis (and its bots setting) to many channels in one go.
 * - Changing one of those channels on its own (/autoreact set · add · remove) gives it its own list again; the
 *   confirmation has a button to update the whole template with that list instead.
 *
 * Every channel keeps its own copy of the emojis (autoReact[channelId].emojis) plus `template: <id>` while it
 * follows one, so reacting to messages never has to look a template up.
 */

const MAX_TEMPLATES = 25; // fits one dropdown and one autocomplete list
const NAME_MAX = 32;
const TTL = 30 * 60 * 1000;
const T = ChannelType;
/** "All chat channels" and whole categories: text, announcement, forum and media channels (no voice chats or threads). */
const CHAT = new Set([T.GuildText, T.GuildAnnouncement, T.GuildForum, T.GuildMedia]);
/** Channels that can be picked one by one (the same kinds as /autoreact set). */
const PICKABLE = [T.GuildText, T.GuildAnnouncement, T.GuildVoice, T.GuildStageVoice, T.GuildForum, T.GuildMedia, T.PublicThread, T.PrivateThread, T.AnnouncementThread];
const NEEDED = ['ViewChannel', 'ReadMessageHistory', 'AddReactions'];
const PERM_NAMES = { ViewChannel: 'View Channel', ReadMessageHistory: 'Read Message History', AddReactions: 'Add Reactions', UseExternalEmojis: 'Use External Emoji' };

const sessions = new Map();
setInterval(() => {
  const cutoff = Date.now() - TTL;
  for (const [sid, s] of sessions) if (s.createdAt < cutoff) sessions.delete(sid);
}, 5 * 60 * 1000).unref();

/* ───────────────────────── helpers ───────────────────────── */

const listText = (emojis) => emojis.map(emojiText).join(' ');
const plain = ({ id, name, animated }) => ({ id: id ?? null, name, animated: Boolean(animated) });
const sameList = (a = [], b = []) => a.length === b.length && a.every((e, i) => emojiKey(e) === emojiKey(b[i]));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const shown = (t) => escapeMarkdown(t.name);
const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'en', { sensitivity: 'base' });

/** "<#a> <#b> <#c> +4 more" */
function channelsText(ids, max = 20) {
  const list = ids.slice(0, max).map((id) => `<#${id}>`).join(' ');
  return ids.length > max ? `${list} +${ids.length - max} more` : list;
}

const templatesOf = (guildId) => store.guild(guildId).reactTemplates;

/** IDs of the channels that follow a template. */
function followers(guildId, templateId) {
  return Object.entries(store.guild(guildId).autoReact)
    .filter(([, c]) => c.template === templateId && c.emojis?.length)
    .map(([id]) => id);
}

/** A template by its ID (what autocomplete sends) or by its name (typed, any case). */
function findTemplate(guildId, input) {
  const all = templatesOf(guildId);
  const s = String(input ?? '').trim();
  if (Object.hasOwn(all, s)) return { id: s, t: all[s] };
  const lower = s.replace(/\s+/g, ' ').toLowerCase();
  const hit = Object.entries(all).find(([, t]) => t.name.toLowerCase() === lower);
  return hit ? { id: hit[0], t: hit[1] } : null;
}

function requireTemplate(guild, input) {
  const found = findTemplate(guild.id, input);
  if (!found) {
    throw new UserError(`There’s no template called “${escapeMarkdown(truncate(String(input ?? ''), 40))}”. See ${ui.cmd(guild.id, 'autoreact template list')}.`, 'Template not found');
  }
  return found;
}

function cleanName(input) {
  const name = String(input ?? '').replace(/\s+/g, ' ').trim();
  if (!name) throw new UserError('Give the template a name, e.g. **Hype**.', 'Name needed');
  if (name.length > NAME_MAX) throw new UserError(`Template names can be up to ${NAME_MAX} characters.`, 'Name too long');
  return name;
}

function assertNewName(guild, name) {
  const all = templatesOf(guild.id);
  if (Object.values(all).some((t) => t.name.toLowerCase() === name.toLowerCase())) {
    throw new UserError(`You already have a template called “${escapeMarkdown(name)}”. Pick another name, or change that one with ${ui.cmd(guild.id, 'autoreact template edit')}.`, 'Name taken');
  }
  if (Object.keys(all).length >= MAX_TEMPLATES) throw new UserError(`You can have up to ${MAX_TEMPLATES} templates. Delete one first.`, 'Too many templates');
}

function assertList(emojis) {
  if (!emojis.length) throw new UserError('Pick at least one emoji.', 'No emojis');
  if (emojis.length > autoReact.MAX_EMOJIS) throw new UserError(`A template can have up to ${autoReact.MAX_EMOJIS} emojis (Discord’s limit per message).`, 'Too many emojis');
}

function createTemplate(guild, name, emojis) {
  assertNewName(guild, name);
  assertList(emojis);
  const all = templatesOf(guild.id);
  let id;
  do id = `t${crypto.randomBytes(4).toString('hex')}`;
  while (Object.hasOwn(all, id));
  all[id] = { name, emojis: emojis.map(plain), createdAt: Date.now(), updatedAt: Date.now() };
  return id;
}

/** Copies a template's emojis to every channel that follows it. Returns their IDs. */
function syncFollowers(guildId, templateId) {
  const g = store.guild(guildId);
  const t = g.reactTemplates[templateId];
  const ids = followers(guildId, templateId);
  for (const id of ids) {
    g.autoReact[id].emojis = t.emojis.map(plain);
    g.autoReact[id].updatedAt = Date.now();
  }
  return ids;
}

/** The template a channel follows (if it still exists). */
function templateOfChannel(guildId, channelId) {
  const g = store.guild(guildId);
  const id = g.autoReact[channelId]?.template;
  return id && Object.hasOwn(g.reactTemplates, id) ? { id, t: g.reactTemplates[id] } : null;
}

/** Custom emojis from this server (or Unicode) can be shown on a dropdown option. */
function optionEmoji(guild, e) {
  if (!e) return undefined;
  if (!e.id) return { name: e.name };
  return guild.emojis.cache.has(e.id) ? { id: e.id, name: e.name, animated: Boolean(e.animated) } : undefined;
}

/* ───────────────────────── cards ───────────────────────── */

/** Shown after a template is created or its emojis change. */
function savedCard(guild, id, { created, note = null }) {
  const t = templatesOf(guild.id)[id];
  const using = followers(guild.id, id);
  const lines = [`## ${listText(t.emojis)}`];
  if (using.length) lines.push(`${created ? 'Used in' : 'Updated in'} ${plural(using.length, 'channel')}: ${channelsText(using)}`);
  else lines.push('Now put it on your channels. They’ll all react with these emojis, and when you edit the template, they all update.');
  if (note) lines.push(`-# ${note}`);
  return ui.notice('success', `Template “${shown(t)}” ${created ? 'saved' : 'updated'}`, lines.join('\n'), {
    buttons: [ui.button({ id: `rt:use:${id}`, label: using.length ? 'Use in more channels' : 'Use in channels', emoji: '📌', style: ButtonStyle.Primary })],
  });
}

/** /autoreact template list */
function templateListCard(guild) {
  const cmd = (name) => ui.cmd(guild.id, name);
  const all = Object.entries(templatesOf(guild.id)).sort(([, a], [, b]) => byName(a, b));
  if (!all.length) {
    return ui.notice(
      'info',
      'No templates yet',
      `Make one with ${cmd('autoreact template create')}: pick its emojis once, then put it on as many channels as you like. Edit it later and every channel using it updates.`,
    );
  }
  const blocks = [];
  let used = 0;
  for (const [id, t] of all) {
    const using = followers(guild.id, id);
    const block = `**📋 ${shown(t)}** · ${using.length ? `${plural(using.length, 'channel')}: ${channelsText(using, 6)}` : 'not used yet'}\n${t.emojis.length ? listText(t.emojis) : '*(no emojis left: edit it to add some)*'}`;
    if (used + block.length > 3000) {
      blocks.push(`-# …and ${all.length - blocks.length} more (all of them are in the menus below)`);
      break;
    }
    blocks.push(block);
    used += block.length + 2;
  }
  const options = () =>
    all.map(([id, t]) => {
      const o = {
        label: truncate(t.name, 100),
        value: id,
        description: truncate(`${plural(t.emojis.length, 'emoji')} · used in ${plural(followers(guild.id, id).length, 'channel')}`, 100),
      };
      const emoji = optionEmoji(guild, t.emojis[0]);
      if (emoji) o.emoji = emoji;
      return o;
    });
  const c = ui.container(config.brand.color).addTextDisplayComponents(ui.text(`## 📋 Emoji templates\n${blocks.join('\n\n')}`));
  c.addSeparatorComponents(ui.divider());
  c.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('rt:apply').setPlaceholder('📌 Put a template on channels…').setMinValues(1).setMaxValues(1).addOptions(options()),
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('rt:edit').setPlaceholder('✏️ Change a template’s emojis…').setMinValues(1).setMaxValues(1).addOptions(options()),
    ),
  );
  c.addTextDisplayComponents(
    ui.text(`-# ${cmd('autoreact template create')} · ${cmd('autoreact template apply')} · ${cmd('autoreact template edit')} · ${cmd('autoreact template delete')}`),
  );
  return { components: [c], flags: ui.V2, allowedMentions: { parse: [] } };
}

/* ───────────────────────── the channel chooser ───────────────────────── */

function newSession(interaction, data) {
  const sid = crypto.randomBytes(5).toString('hex');
  const s = { sid, userId: interaction.user.id, guildId: interaction.guildId, createdAt: Date.now(), picked: [], categories: [], all: false, ...data };
  sessions.set(sid, s);
  return s;
}

function sessionFor(interaction, sid) {
  const s = sessions.get(sid);
  if (!s) throw new UserError('This channel list expired (they last 30 minutes). Run the command again.', 'List expired');
  if (s.userId !== interaction.user.id) throw new UserError('This channel list belongs to someone else.', 'Not yours');
  return s;
}

/** What gets copied: the emojis, the bots setting (copy only) and the template the channels will follow. */
function sourceOf(guild, s) {
  const g = store.guild(guild.id);
  if (s.mode === 'template') {
    const t = g.reactTemplates[s.templateId];
    if (!t) throw new UserError('That template was deleted.', 'Template deleted');
    if (!t.emojis.length) {
      throw new UserError(`The template “${shown(t)}” has no emojis left. Add some with ${ui.cmd(guild.id, 'autoreact template edit')}.`, 'Empty template');
    }
    return { emojis: t.emojis, templateId: s.templateId, template: t, bots: null };
  }
  const cfg = g.autoReact[s.sourceId];
  if (!cfg?.emojis?.length) throw new UserError(`<#${s.sourceId}> has no auto reactions any more.`, 'Nothing to copy');
  const link = templateOfChannel(guild.id, s.sourceId);
  return { emojis: cfg.emojis, templateId: link?.id ?? null, template: link?.t ?? null, bots: cfg.bots !== false };
}

function missingPerms(guild, channel, external) {
  const have = channel.permissionsFor?.(guild.members.me);
  const need = external ? [...NEEDED, 'UseExternalEmojis'] : NEEDED;
  return need.filter((p) => !have?.has(PermissionFlagsBits[p]));
}

const canSee = (guild, channel) => !missingPerms(guild, channel, false).includes('ViewChannel');

/** Every chat channel the bot can see (what "All chat channels" adds). */
function chatChannels(guild, s) {
  return [...guild.channels.cache.values()].filter((ch) => CHAT.has(ch.type) && ch.id !== s.sourceId && canSee(guild, ch));
}

/** The channels the choices add up to, split into ones the bot can react in and ones it can't. */
function targetsOf(guild, s, src) {
  const ids = new Set(s.picked);
  if (s.categories.length) {
    const cats = new Set(s.categories);
    for (const ch of guild.channels.cache.values()) if (cats.has(ch.parentId) && CHAT.has(ch.type)) ids.add(ch.id);
  }
  if (s.all) for (const ch of chatChannels(guild, s)) ids.add(ch.id);
  if (s.mode === 'copy') ids.delete(s.sourceId);
  const external = src.emojis.some((e) => e.id && !guild.emojis.cache.has(e.id));
  const ok = [];
  const blocked = [];
  for (const id of ids) {
    const ch = guild.channels.cache.get(id);
    if (!ch || ch.type === T.GuildCategory) continue;
    const missing = missingPerms(guild, ch, external);
    if (missing.length) blocked.push({ ch, missing });
    else ok.push(ch);
  }
  ok.sort(byName);
  blocked.sort((a, b) => byName(a.ch, b.ch));
  return { ok, blocked };
}

const missingText = (blocked) => [...new Set(blocked.flatMap((b) => b.missing))].map((p) => `**${PERM_NAMES[p]}**`).join(', ');

function chooser(guild, s) {
  const src = sourceOf(guild, s);
  const { ok, blocked } = targetsOf(guild, s, src);
  const g = store.guild(guild.id);
  const head =
    s.mode === 'template'
      ? [`## 📋 Use the template “${shown(src.template)}”`, `## ${listText(src.emojis)}`, 'Pick the channels below. They’ll react with these emojis, and **when you edit the template, they all update**.']
      : [
          '## 📋 Copy auto reactions',
          `From <#${s.sourceId}> · ${src.bots ? '🤖 bots too' : '👤 members only'}${src.template ? ` · template “${shown(src.template)}”` : ''}`,
          `## ${listText(src.emojis)}`,
          'Pick the channels below. They get the same emojis, and their own auto reactions are replaced.',
        ];
  const c = ui.container(config.brand.color);
  c.addTextDisplayComponents(ui.text(head.join('\n')));
  c.addSeparatorComponents(ui.divider());

  const known = (ids) => ids.filter((id) => guild.channels.cache.has(id));
  const channelMenu = new ChannelSelectMenuBuilder()
    .setCustomId(`rt:ch:${s.sid}`)
    .setPlaceholder('📌 Pick channels (up to 25)')
    .setChannelTypes(...PICKABLE)
    .setMinValues(0)
    .setMaxValues(25);
  if (known(s.picked).length) channelMenu.setDefaultChannels(...known(s.picked));
  const categoryMenu = new ChannelSelectMenuBuilder()
    .setCustomId(`rt:cat:${s.sid}`)
    .setPlaceholder('📁 …or whole categories (all their chat channels)')
    .setChannelTypes(T.GuildCategory)
    .setMinValues(0)
    .setMaxValues(25);
  if (known(s.categories).length) categoryMenu.setDefaultChannels(...known(s.categories));
  c.addActionRowComponents(new ActionRowBuilder().addComponents(channelMenu), new ActionRowBuilder().addComponents(categoryMenu));
  const everything = chatChannels(guild, s).length;
  c.addActionRowComponents(
    ui.row(
      ui.button({ id: `rt:all:${s.sid}`, label: `All chat channels (${everything})${s.all ? ' ✓' : ''}`, emoji: '🌐', style: s.all ? ButtonStyle.Primary : ButtonStyle.Secondary }),
      ui.button({ id: `rt:c:${s.sid}`, label: 'Clear', emoji: '🗑️', disabled: !s.picked.length && !s.categories.length && !s.all }),
    ),
  );

  const info = [];
  if (ok.length) info.push(`**${plural(ok.length, 'channel')} selected:** ${channelsText(ok.map((ch) => ch.id))}`);
  else if (blocked.length) info.push('**None of these channels can get reactions from me yet** (see below).');
  else info.push('**Nothing selected yet.** Pick channels, whole categories, or all chat channels.');
  const replaced = ok.filter((ch) => {
    const cur = g.autoReact[ch.id];
    return cur?.emojis?.length && (!sameList(cur.emojis, src.emojis) || (cur.template ?? null) !== (src.templateId ?? null));
  }).length;
  if (replaced) info.push(`-# ♻️ ${replaced} of them already ${replaced === 1 ? 'has' : 'have'} other auto reactions: those are replaced.`);
  if (blocked.length) info.push(`-# ⚠️ I can’t react in ${channelsText(blocked.map((b) => b.ch.id), 10)} (missing ${missingText(blocked)}), so ${blocked.length === 1 ? 'it’s' : 'they’re'} skipped.`);
  c.addTextDisplayComponents(ui.text(info.join('\n')));
  c.addSeparatorComponents(ui.divider());
  c.addActionRowComponents(
    ui.row(
      ui.button({ id: `rt:ok:${s.sid}`, label: ok.length ? `Apply to ${plural(ok.length, 'channel')}` : 'Apply', emoji: '✅', style: ButtonStyle.Success, disabled: !ok.length }),
      ui.button({ id: `rt:x:${s.sid}`, label: 'Cancel', style: ButtonStyle.Danger }),
    ),
  );
  return { components: [c], flags: ui.V2, allowedMentions: { parse: [] } };
}

function openChooser(interaction, data) {
  return chooser(interaction.guild, newSession(interaction, data));
}

/** ✅ Apply: writes the emojis to every chosen channel the bot can react in. */
function apply(guild, s) {
  const src = sourceOf(guild, s);
  const { ok, blocked } = targetsOf(guild, s, src);
  if (!ok.length) throw new UserError('Pick at least one channel I can react in.', 'No channels');
  const g = store.guild(guild.id);
  const now = Date.now();
  for (const ch of ok) {
    const before = g.autoReact[ch.id];
    const cfg = { emojis: src.emojis.map(plain), bots: src.bots ?? before?.bots ?? true, updatedAt: now };
    if (src.templateId) cfg.template = src.templateId;
    g.autoReact[ch.id] = cfg;
  }
  store.save(guild.id);
  sessions.delete(s.sid);
  const lines = [`## ${listText(src.emojis)}`, channelsText(ok.map((ch) => ch.id), 30)];
  if (src.templateId) {
    lines.push(`-# They follow the template${s.mode === 'copy' ? ` “${shown(src.template)}”` : ''}: change it with ${ui.cmd(guild.id, 'autoreact template edit')} and they all update.`);
  }
  lines.push('-# Every new message there gets these reactions. Messages that are already there aren’t touched.');
  if (blocked.length) lines.push(`-# ⚠️ Skipped ${channelsText(blocked.map((b) => b.ch.id), 10)}: I’m missing ${missingText(blocked)} there.`);
  const title = s.mode === 'template' ? `“${shown(src.template)}” is on ${plural(ok.length, 'channel')}` : `Copied to ${plural(ok.length, 'channel')}`;
  return ui.notice(blocked.length ? 'warn' : 'success', title, lines.join('\n'));
}

/** "Also update the template" on a channel that was just changed on its own. */
function pushToTemplate(interaction, channelId, templateId) {
  const guild = interaction.guild;
  const g = store.guild(guild.id);
  const t = g.reactTemplates[templateId];
  if (!t) throw new UserError('That template was deleted.', 'Template deleted');
  const cfg = g.autoReact[channelId];
  if (!cfg?.emojis?.length) throw new UserError(`<#${channelId}> has no auto reactions any more.`, 'Nothing to copy');
  t.emojis = cfg.emojis.map(plain);
  t.updatedAt = Date.now();
  cfg.template = templateId;
  syncFollowers(guild.id, templateId);
  store.save(guild.id);
  return ui.updateMessage(interaction, savedCard(guild, templateId, { created: false }));
}

/* ───────────────────────── commands ───────────────────────── */

/** /autoreact copy from:#channel */
async function copyCommand(interaction) {
  const guild = interaction.guild;
  const from = interaction.options.getChannel('from', true);
  const cfg = store.guild(guild.id).autoReact[from.id];
  if (!cfg?.emojis?.length) throw new UserError(`${from} has no auto reactions to copy. Set them first with ${ui.cmd(guild.id, 'autoreact set')}.`, 'Nothing to copy');
  return ui.respond(interaction, openChooser(interaction, { mode: 'copy', sourceId: from.id }));
}

/** /autoreact template create · apply · edit · delete · list */
async function templateCommand(interaction) {
  const guild = interaction.guild;
  const g = store.guild(guild.id);
  const sub = interaction.options.getSubcommand();

  if (sub === 'create') {
    const name = cleanName(interaction.options.getString('name', true));
    assertNewName(guild, name);
    const from = interaction.options.getChannel('from');
    if (!from) return require('./reactPicker').openForTemplate(interaction, { templateId: null, name, chosen: [] });
    const cfg = g.autoReact[from.id];
    if (!cfg?.emojis?.length) {
      throw new UserError(`${from} has no auto reactions to copy. Leave **from** empty to pick the emojis from a list instead.`, 'Nothing to copy');
    }
    const id = createTemplate(guild, name, cfg.emojis);
    cfg.template = id;
    store.save(guild.id);
    return ui.respond(interaction, savedCard(guild, id, { created: true }));
  }
  if (sub === 'list') return ui.respond(interaction, templateListCard(guild));

  const { id, t } = requireTemplate(guild, interaction.options.getString('name', true));
  if (sub === 'apply') return ui.respond(interaction, openChooser(interaction, { mode: 'template', templateId: id }));
  if (sub === 'edit') return require('./reactPicker').openForTemplate(interaction, { templateId: id, name: t.name, chosen: t.emojis });
  if (sub === 'delete') {
    const using = followers(guild.id, id);
    for (const cfg of Object.values(g.autoReact)) if (cfg.template === id) delete cfg.template;
    delete g.reactTemplates[id];
    store.save(guild.id);
    const body = using.length
      ? `${channelsText(using)} keep their emojis. They just don’t update together any more.\n-# To turn one off: ${ui.cmd(guild.id, 'autoreact remove')}`
      : 'It wasn’t used in any channel.';
    return ui.respond(interaction, ui.notice('success', `Template “${shown(t)}” deleted`, body));
  }
  throw new UserError('Unknown option.');
}

/** Saves the emoji list's choice (the picker's ✅ Save template). */
function saveFromPicker(guild, s) {
  if (s.templateId) {
    const t = templatesOf(guild.id)[s.templateId];
    if (!t) throw new UserError('That template was deleted in the meantime.', 'Template deleted');
    assertList(s.chosen);
    t.emojis = s.chosen.map(plain);
    t.updatedAt = Date.now();
    syncFollowers(guild.id, s.templateId);
    store.save(guild.id);
    return savedCard(guild, s.templateId, { created: false });
  }
  const id = createTemplate(guild, s.templateName, s.chosen);
  store.save(guild.id);
  return savedCard(guild, id, { created: true });
}

/** Autocomplete for the `name:` of /autoreact template apply · edit · delete. */
function templateChoices(guild, query) {
  const q = String(query ?? '').trim().toLowerCase();
  return Object.entries(templatesOf(guild.id))
    .filter(([, t]) => !q || t.name.toLowerCase().includes(q))
    .sort(([, a], [, b]) => byName(a, b))
    .slice(0, 25)
    .map(([id, t]) => ({ name: truncate(`${t.name} · ${plural(t.emojis.length, 'emoji')} · used in ${plural(followers(guild.id, id).length, 'channel')}`, 100), value: id }));
}

/* ───────────────────────── buttons & menus ───────────────────────── */

async function onComponent(interaction) {
  const [, action, a, b] = interaction.customId.split(':');
  const guild = interaction.guild;
  switch (action) {
    case 'use': {
      // "📌 Use in channels" under a saved template
      if (!templatesOf(guild.id)[a]) throw new UserError('That template was deleted.', 'Template deleted');
      return ui.updateMessage(interaction, openChooser(interaction, { mode: 'template', templateId: a }));
    }
    case 'apply': // template list → "Put a template on channels…"
      return ui.updateMessage(interaction, openChooser(interaction, { mode: 'template', templateId: requireTemplate(guild, interaction.values?.[0]).id }));
    case 'edit': {
      // template list → "Change a template's emojis…"
      const { id, t } = requireTemplate(guild, interaction.values?.[0]);
      return require('./reactPicker').openForTemplate(interaction, { templateId: id, name: t.name, chosen: t.emojis }, { update: true });
    }
    case 'push':
      return pushToTemplate(interaction, a, b);
    default:
  }
  const s = sessionFor(interaction, a);
  switch (action) {
    case 'ch':
      s.picked = [...(interaction.values ?? [])];
      break;
    case 'cat':
      s.categories = [...(interaction.values ?? [])];
      break;
    case 'all':
      s.all = !s.all;
      break;
    case 'c':
      Object.assign(s, { picked: [], categories: [], all: false });
      break;
    case 'x':
      sessions.delete(s.sid);
      return ui.updateMessage(interaction, ui.notice('info', 'Cancelled', 'Nothing was changed.'));
    case 'ok':
      return ui.updateMessage(interaction, apply(guild, s));
    default:
      throw new UserError('Unknown button.');
  }
  return ui.updateMessage(interaction, chooser(guild, s));
}

module.exports = {
  copyCommand,
  templateCommand,
  saveFromPicker,
  templateChoices,
  templateListCard,
  templateOfChannel,
  followers,
  sameList,
  onComponent,
  chooser,
  newSession,
  CHAT,
  MAX_TEMPLATES,
};
