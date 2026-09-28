'use strict';
const { LabelBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits, SectionBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const config = require('../config');
const store = require('../lib/store');
const log = require('../lib/log');
const ui = require('../lib/ui');
const { parseColor, isDefaultColorKeyword } = require('../lib/color');
const {
  UserError,
  truncate,
  parseMessageRef,
  parseEmoji,
  emojiKey,
  emojiText,
  botRoleProblem,
  selfAssignProblem,
  assertBotChannelPerms,
  messageUrl,
} = require('../lib/utils');

/**
 * Classic reaction roles — react with an emoji, get a role.
 * Works on a bot-made panel (auto-lists its roles) or on ANY existing message.
 *
 * Modes:  normal → react = get, unreact = lose
 *         unique → only one role from the message at a time
 *         verify → reacting gives the role permanently (great for rules/verification)
 */

const MODE_LABEL = { normal: 'Normal', unique: 'One at a time', verify: 'Verify (permanent)' };
const MODE_HINT = {
  normal: 'React below to get a role · remove your reaction to drop it.',
  unique: 'React to pick **one** role · picking another swaps it.',
  verify: 'React below to get your role.',
};
const MAX_REACTIONS = 20; // Discord's limit of different reactions per message

const pending = new Map();
setInterval(() => {
  const cutoff = Date.now() - 20 * 60 * 1000;
  for (const [k, v] of pending) if (v.createdAt < cutoff) pending.delete(k);
}, 5 * 60 * 1000).unref();

function renderPanel(guild, cfg) {
  const p = cfg.panel;
  const c = ui.container(p.color ?? config.brand.color);
  const header = `# ${p.title}${p.description ? `\n${p.description}` : ''}`;
  const icon = guild.iconURL?.({ extension: 'png', size: 256 });
  if (icon) c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(ui.text(header)).setThumbnailAccessory(ui.thumbnail(icon, guild.name)));
  else c.addTextDisplayComponents(ui.text(header));
  c.addSeparatorComponents(ui.divider(true));
  const lines = cfg.entries.map((e) => `${emojiText(e.emoji)}  <@&${e.roleId}>${e.description ? `\n-# ${e.description}` : ''}`);
  c.addTextDisplayComponents(ui.text(lines.length ? truncate(lines.join('\n'), 3000) : '-# ✨ Roles are being set up — check back soon!'));
  c.addSeparatorComponents(ui.divider());
  c.addTextDisplayComponents(ui.text(`-# ${MODE_HINT[cfg.mode] ?? MODE_HINT.normal}`));
  return { components: [c], flags: ui.V2, allowedMentions: { parse: [] } };
}

async function refreshPanel(guild, message, cfg) {
  if (!cfg.panel || message.author?.id !== guild.client.user.id) return;
  await message.edit(renderPanel(guild, cfg));
}

async function resolveMessage(interaction, input) {
  const ref = parseMessageRef(input);
  if (!ref) {
    throw new UserError('Paste a message **link** (right-click the message → **Copy Message Link**) or pick one from the list.', 'Which message?');
  }
  if (ref.guildId && ref.guildId !== interaction.guildId) throw new UserError('That message is in a different server.');
  const saved = store.guild(interaction.guildId).reactionRoles[ref.messageId];
  const channelId = ref.channelId ?? saved?.channelId ?? interaction.channelId;
  const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) throw new UserError('I couldn’t find that channel.');
  const message = await channel.messages.fetch(ref.messageId).catch(() => null);
  if (!message) {
    throw new UserError(
      ref.channelId ? 'I couldn’t find that message (or I can’t see that channel).' : 'I couldn’t find that message in this channel — paste the message **link** instead of the ID.',
      'Message not found',
    );
  }
  return message;
}

function resolveColor(input) {
  if (!input) return null;
  if (isDefaultColorKeyword(input)) return null;
  const c = parseColor(input);
  if (c === null) throw new UserError('Colours look like `#7C5CFF` or a name like `purple`, `gold`, `cyan`.', 'Invalid colour');
  return c;
}

/* ───────────────────────── /reactionroles ───────────────────────── */

async function command(interaction) {
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;
  const g = store.guild(guild.id);

  if (sub === 'create') {
    const channel = interaction.options.getChannel('channel', true);
    assertBotChannelPerms(channel, ['ViewChannel', 'SendMessages', 'AddReactions', 'ReadMessageHistory']);
    pending.set(interaction.id, {
      channelId: channel.id,
      mode: interaction.options.getString('mode') ?? 'normal',
      color: resolveColor(interaction.options.getString('color')),
      createdAt: Date.now(),
    });
    const input = (id, style, max, required, placeholder) =>
      new TextInputBuilder().setCustomId(id).setStyle(style).setMaxLength(max).setRequired(required).setPlaceholder(placeholder);
    return interaction.showModal(
      new ModalBuilder()
        .setCustomId(`rr:create:${interaction.id}`)
        .setTitle('New reaction-role panel')
        .addLabelComponents(
          new LabelBuilder().setLabel('Title').setDescription('Big heading at the top').setTextInputComponent(input('title', TextInputStyle.Short, 120, true, '🎮 React for your game roles')),
          new LabelBuilder()
            .setLabel('Description (optional)')
            .setDescription('Shown under the title — markdown works')
            .setTextInputComponent(input('description', TextInputStyle.Paragraph, 1500, false, 'Pick the games you play to get pinged for brackets.')),
        ),
    );
  }

  if (sub === 'add') {
    const message = await resolveMessage(interaction, interaction.options.getString('message', true));
    const role = interaction.options.getRole('role', true);
    const problem = selfAssignProblem(interaction.member, role);
    if (problem) throw new UserError(problem, 'Can’t use that role');
    const emoji = parseEmoji(interaction.options.getString('emoji', true), guild);
    if (!emoji) throw new UserError('That doesn’t look like an emoji. Use a normal emoji (🎮) or a custom emoji.', 'Invalid emoji');
    const key = emojiKey(emoji);
    const description = interaction.options.getString('description')?.trim() || null;

    const cfg = g.reactionRoles[message.id] ?? { channelId: message.channelId, mode: 'normal', panel: null, entries: [] };
    const existing = cfg.entries.find((e) => e.key === key);
    if (!existing && cfg.entries.length >= MAX_REACTIONS) throw new UserError(`A message can have at most ${MAX_REACTIONS} different reactions.`);
    const perms = ['ViewChannel', 'ReadMessageHistory', 'AddReactions'];
    if (emoji.id && !guild.emojis.cache.has(emoji.id)) perms.push('UseExternalEmojis');
    assertBotChannelPerms(message.channel, perms);

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      await message.react(emoji.id ? emojiText(emoji) : emoji.name);
    } catch {
      throw new UserError('I couldn’t react with that emoji. Custom emojis must be from a server I’m in.', 'Invalid emoji');
    }
    if (existing) Object.assign(existing, { emoji, roleId: role.id, description });
    else cfg.entries.push({ key, emoji, roleId: role.id, description });
    g.reactionRoles[message.id] = cfg;
    store.save(guild.id);
    await refreshPanel(guild, message, cfg).catch((err) => log.warn('Could not refresh reaction panel:', err.message));
    return interaction.editReply(
      ui.notice('success', existing ? 'Reaction role updated' : 'Reaction role added', `${emojiText(emoji)} → ${role}\n-# Mode: ${MODE_LABEL[cfg.mode]} · ${cfg.entries.length} role(s) on this message`, {
        buttons: [ui.button({ label: 'Open message', emoji: '🔗', url: message.url })],
      }),
    );
  }

  if (sub === 'remove') {
    const message = await resolveMessage(interaction, interaction.options.getString('message', true));
    const cfg = g.reactionRoles[message.id];
    if (!cfg) throw new UserError('That message has no reaction roles.');
    const emoji = parseEmoji(interaction.options.getString('emoji', true), guild);
    const key = emojiKey(emoji);
    const entry = cfg.entries.find((e) => e.key === key);
    if (!entry) throw new UserError('That emoji isn’t set up on this message.');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    cfg.entries = cfg.entries.filter((e) => e.key !== key);
    const reaction = message.reactions.cache.find((r) => emojiKey(r.emoji) === key);
    if (reaction) {
      const canManage = message.channel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.ManageMessages);
      await (canManage ? reaction.remove() : reaction.users.remove(guild.client.user.id)).catch(() => {});
    }
    if (!cfg.entries.length && !cfg.panel) delete g.reactionRoles[message.id];
    store.save(guild.id);
    await refreshPanel(guild, message, cfg).catch(() => {});
    return interaction.editReply(ui.notice('success', 'Reaction role removed', `${emojiText(entry.emoji)} → <@&${entry.roleId}> was removed.\n-# Members keep roles they already have.`));
  }

  if (sub === 'mode') {
    const message = await resolveMessage(interaction, interaction.options.getString('message', true));
    const cfg = g.reactionRoles[message.id];
    if (!cfg) throw new UserError('That message has no reaction roles yet.');
    cfg.mode = interaction.options.getString('mode', true);
    if (cfg.mode === 'unique') assertBotChannelPerms(message.channel, ['ManageMessages']);
    store.save(guild.id);
    await refreshPanel(guild, message, cfg).catch(() => {});
    return ui.respond(interaction, ui.notice('success', 'Mode updated', `**${MODE_LABEL[cfg.mode]}** — ${MODE_HINT[cfg.mode].replace(' below', '')}`));
  }

  if (sub === 'clear') {
    const message = await resolveMessage(interaction, interaction.options.getString('message', true));
    const cfg = g.reactionRoles[message.id];
    if (!cfg) throw new UserError('That message has no reaction roles.');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    delete g.reactionRoles[message.id];
    store.save(guild.id);
    const canManage = message.channel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.ManageMessages);
    if (canManage) await message.reactions.removeAll().catch(() => {});
    else for (const r of message.reactions.cache.values()) await r.users.remove(guild.client.user.id).catch(() => {});
    return interaction.editReply(ui.notice('success', 'Reaction roles cleared', 'The message was kept — delete it yourself if you don’t need it anymore.'));
  }

  if (sub === 'list') {
    const entries = Object.entries(g.reactionRoles);
    if (!entries.length) {
      return ui.respond(interaction, ui.notice('info', 'No reaction roles yet', `Create a panel with ${ui.cmd(guild.id, 'reactionroles create')} or add to any message with ${ui.cmd(guild.id, 'reactionroles add')}.`));
    }
    const blocks = entries.slice(0, 15).map(([messageId, cfg]) => {
      const pairs = cfg.entries.map((e) => `${emojiText(e.emoji)} <@&${e.roleId}>`).join('  ') || '—';
      const name = cfg.panel ? truncate(cfg.panel.title, 60) : 'Message';
      return `**[${name}](${messageUrl(guild.id, cfg.channelId, messageId)})** · ${MODE_LABEL[cfg.mode]}\n${pairs}`;
    });
    const c = ui.container(config.brand.color).addTextDisplayComponents(ui.text(truncate(`## 😀 Reaction roles\n${blocks.join('\n\n')}`, 3800)));
    return ui.respond(interaction, { components: [c], flags: ui.V2, allowedMentions: { parse: [] } });
  }

  throw new UserError('Unknown option.');
}

async function onModal(interaction) {
  const [, , key] = interaction.customId.split(':');
  const p = pending.get(key);
  pending.delete(key);
  if (!p) throw new UserError('This form expired — please run the command again.', 'Form expired');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  const channel = await guild.channels.fetch(p.channelId).catch(() => null);
  if (!channel) throw new UserError('That channel no longer exists.');
  const cfg = {
    channelId: channel.id,
    mode: p.mode,
    panel: {
      title: interaction.fields.getTextInputValue('title').trim() || 'Reaction roles',
      description: interaction.fields.getTextInputValue('description').trim(),
      color: p.color,
    },
    entries: [],
  };
  const message = await channel.send(renderPanel(guild, cfg));
  store.guild(guild.id).reactionRoles[message.id] = cfg;
  store.save(guild.id);
  return interaction.editReply(
    ui.notice('success', 'Reaction panel posted', `Now add emoji → role pairs with ${ui.cmd(guild.id, 'reactionroles add')} — this panel appears first in the **message** list.\n-# The panel lists its roles automatically as you add them.`, {
      buttons: [ui.button({ label: 'Open panel', emoji: '🔗', url: message.url })],
    }),
  );
}

/* ───────────────────────── reaction events ───────────────────────── */

async function context(reaction, user) {
  const message = reaction.message;
  const guildId = message.guildId;
  if (!guildId || user.id === reaction.client.user.id) return null;
  const cfg = store.guilds[guildId]?.reactionRoles?.[message.id];
  if (!cfg) return null;
  const key = emojiKey(reaction.emoji);
  const entry = cfg.entries.find((e) => e.key === key);
  if (!entry) return null;
  const guild = message.guild ?? (await reaction.client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return null;
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member || member.user.bot) return null;
  return { guild, cfg, entry, member, key };
}

async function onReactionAdd(reaction, user) {
  const ctx = await context(reaction, user);
  if (!ctx) return;
  const { guild, cfg, entry, member, key } = ctx;
  const role = guild.roles.cache.get(entry.roleId);
  const problem = botRoleProblem(guild, role);
  if (problem) return log.warn(`Reaction role skipped in ${guild.name}: ${problem.replace(/\*\*/g, '')}`);
  const why = 'Reaction roles';

  if (cfg.mode === 'unique') {
    const others = cfg.entries.filter((e) => e.key !== key);
    for (const o of others) {
      if (o.roleId !== entry.roleId && member.roles.cache.has(o.roleId) && !botRoleProblem(guild, guild.roles.cache.get(o.roleId))) {
        await member.roles.remove(o.roleId, why).catch(() => {});
      }
    }
    const message = reaction.message.partial ? await reaction.message.fetch().catch(() => null) : reaction.message;
    if (message) {
      for (const r of message.reactions.cache.values()) {
        const k = emojiKey(r.emoji);
        if (k !== key && others.some((o) => o.key === k)) await r.users.remove(user.id).catch(() => {});
      }
    }
  }
  await member.roles.add(entry.roleId, why).catch((err) => log.warn('Reaction role add failed:', err.message));
}

async function onReactionRemove(reaction, user) {
  const ctx = await context(reaction, user);
  if (!ctx || ctx.cfg.mode === 'verify') return;
  const { guild, entry, member } = ctx;
  if (botRoleProblem(guild, guild.roles.cache.get(entry.roleId))) return;
  await member.roles.remove(entry.roleId, 'Reaction roles').catch((err) => log.warn('Reaction role remove failed:', err.message));
}

/* ───────────────────────── autocomplete & cleanup ───────────────────────── */

function messageChoices(guild, query) {
  const q = String(query || '').toLowerCase();
  return Object.entries(store.guild(guild.id).reactionRoles)
    .map(([messageId, cfg]) => ({
      name: truncate(`${cfg.panel ? cfg.panel.title.replace(/[#*_`~]/g, '').trim() : 'Message'} · #${guild.channels.cache.get(cfg.channelId)?.name ?? '?'} · ${cfg.entries.length} role(s)`, 100),
      value: `${cfg.channelId}-${messageId}`,
    }))
    .filter((c) => !q || c.name.toLowerCase().includes(q) || c.value.includes(q))
    .reverse()
    .slice(0, 25);
}

function emojiChoices(guild, messageInput, query) {
  const ref = parseMessageRef(messageInput);
  const cfg = ref && store.guild(guild.id).reactionRoles[ref.messageId];
  if (!cfg) return [];
  const q = String(query || '').toLowerCase();
  return cfg.entries
    .map((e) => ({
      name: truncate(`${e.emoji.id ? `:${e.emoji.name}:` : e.emoji.name} → @${guild.roles.cache.get(e.roleId)?.name ?? 'deleted-role'}`, 100),
      value: e.emoji.id ? emojiText(e.emoji) : e.emoji.name,
    }))
    .filter((c) => !q || c.name.toLowerCase().includes(q))
    .slice(0, 25);
}

function onMessageDelete(guildId, messageId) {
  const g = store.guilds[guildId];
  if (g?.reactionRoles?.[messageId]) {
    delete g.reactionRoles[messageId];
    store.save(guildId);
  }
}

function onRoleDelete(role) {
  const g = store.guilds[role.guild.id];
  if (!g) return;
  let changed = false;
  for (const cfg of Object.values(g.reactionRoles)) {
    const before = cfg.entries.length;
    cfg.entries = cfg.entries.filter((e) => e.roleId !== role.id);
    if (cfg.entries.length !== before) changed = true;
  }
  if (changed) store.save(role.guild.id);
}

module.exports = {
  command,
  onModal,
  onReactionAdd,
  onReactionRemove,
  messageChoices,
  emojiChoices,
  onMessageDelete,
  onRoleDelete,
  renderPanel,
  MODE_LABEL,
};
