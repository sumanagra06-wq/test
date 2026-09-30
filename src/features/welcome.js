'use strict';
const {
  AttachmentBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SectionBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const config = require('../config');
const store = require('../lib/store');
const log = require('../lib/log');
const ui = require('../lib/ui');
const { renderWelcomeCard, prepareBackground } = require('../lib/card');
const { parseColor, isDefaultColorKeyword, toHex } = require('../lib/color');
const autoReact = require('./autoReact');
const {
  UserError,
  fillTemplate,
  ordinal,
  channelUrl,
  download,
  truncate,
  fileKind,
  botRoleProblem,
  selfAssignProblem,
  assertBotChannelPerms,
} = require('../lib/utils');

const PLACEHOLDERS = '`{user}` mention · `{name}` display name · `{username}` · `{server}` · `{members}` count · `{members_ordinal}` e.g. 1,284th';

function templateVars(member) {
  const count = member.guild.memberCount ?? 0;
  return {
    user: `<@${member.id}>`,
    mention: `<@${member.id}>`,
    username: member.user.username,
    name: member.displayName,
    displayname: member.displayName,
    server: member.guild.name,
    members: count.toLocaleString('en-US'),
    membercount: count.toLocaleString('en-US'),
    members_ordinal: ordinal(count),
    id: member.id,
  };
}

/** Builds the full welcome message (banner image + text card + link buttons). */
async function buildWelcomePayload(member, cfg, { preview = false, allowImage = true } = {}) {
  const vars = templateVars(member);
  const color = cfg.color ?? config.brand.color;
  const title = truncate(fillTemplate(cfg.title, vars), 250);
  const body = truncate(fillTemplate(cfg.message, vars), 2500);
  const card = ui.container(color);
  const files = [];

  if (cfg.image && allowImage) {
    try {
      const avatarUrl = member.displayAvatarURL({ extension: 'png', size: 256, forceStatic: true });
      const avatar = await download(avatarUrl, 8 * 1024 * 1024).catch(() => null);
      const png = await renderWelcomeCard({
        avatar,
        displayName: member.displayName,
        username: member.user.username,
        memberCount: member.guild.memberCount,
        serverName: member.guild.name,
        subtitle: fillTemplate(cfg.imageSubtitle || '', vars),
        background: cfg.background ? Buffer.from(cfg.background, 'base64') : null,
        brand: color,
        glow: config.brand.glow,
      });
      files.push(new AttachmentBuilder(png, { name: 'welcome.png', description: `Welcome banner for ${member.user.username}` }));
      card.addMediaGalleryComponents(ui.gallery([{ url: 'attachment://welcome.png', description: `Welcome, ${member.displayName}!` }]));
    } catch (err) {
      log.warn('Welcome banner failed — sending the text card instead:', err.message);
    }
  }

  const heading = `## ${title}\n${body}`;
  if (files.length) {
    card.addTextDisplayComponents(ui.text(heading));
  } else {
    // text-only mode: modern card with the member's avatar on the side
    card.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(ui.text(heading))
        .setThumbnailAccessory(ui.thumbnail(member.displayAvatarURL({ extension: 'png', size: 256 }), member.displayName)),
    );
  }

  const links = [];
  if (cfg.rulesChannelId) links.push(ui.button({ label: 'Rules', emoji: '📜', url: channelUrl(member.guild.id, cfg.rulesChannelId) }));
  if (cfg.rolesChannelId) links.push(ui.button({ label: 'Get roles', emoji: '🎭', url: channelUrl(member.guild.id, cfg.rolesChannelId) }));
  if (links.length) card.addSeparatorComponents(ui.divider()).addActionRowComponents(ui.row(links));

  const joined = Math.floor((member.joinedTimestamp ?? Date.now()) / 1000);
  // the banner already shows the member number, so the footer only needs it in text mode
  card.addTextDisplayComponents(ui.text(files.length ? `-# 👥 Joined <t:${joined}:R>` : `-# 👥 Member #${vars.members} · joined <t:${joined}:R>`));

  return {
    components: [card],
    files,
    flags: ui.V2,
    allowedMentions: cfg.ping && !preview ? { users: [member.id] } : { parse: [] },
  };
}

async function giveAutoRole(member, cfg) {
  const role = member.guild.roles.cache.get(cfg.autoRoleId);
  const problem = botRoleProblem(member.guild, role);
  if (problem) return log.warn(`Auto-role skipped in ${member.guild.name}: ${problem.replace(/\*\*/g, '')}`);
  await member.roles.add(role, 'Welcome auto-role').catch((err) => log.warn('Auto-role failed:', err.message));
}

/* ───────────────────────── events ───────────────────────── */

async function onMemberAdd(member) {
  const cfg = store.guild(member.guild.id).welcome;
  if (cfg.autoRoleId && !member.user.bot && !member.pending) await giveAutoRole(member, cfg);
  if (!cfg.enabled || !cfg.channelId || member.user.bot) return;

  const channel =
    member.guild.channels.cache.get(cfg.channelId) ?? (await member.guild.channels.fetch(cfg.channelId).catch(() => null));
  if (!channel?.isTextBased()) return log.warn(`Welcome channel ${cfg.channelId} not found in ${member.guild.name}`);
  const perms = channel.permissionsFor(member.guild.members.me);
  if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    return log.warn(`Missing permission to send welcome messages in #${channel.name}`);
  }
  const payload = await buildWelcomePayload(member, cfg, { allowImage: perms.has(PermissionFlagsBits.AttachFiles) });
  autoReact.reactToOwnPost(await channel.send(payload));
}

/** Members who had to pass Membership Screening get the auto-role once they accept the rules. */
async function onMemberUpdate(oldMember, newMember) {
  if (!oldMember.pending || newMember.pending || newMember.user.bot) return;
  const cfg = store.guild(newMember.guild.id).welcome;
  if (cfg.autoRoleId) await giveAutoRole(newMember, cfg);
}

/* ───────────────────────── /welcome ───────────────────────── */

function resolveColor(input) {
  if (!input) return undefined;
  if (isDefaultColorKeyword(input)) return null;
  const c = parseColor(input);
  if (c === null) throw new UserError('Colours look like `#7C5CFF` or a name like `purple`, `gold`, `cyan`.', 'Invalid colour');
  return c;
}

function settingsCard(guild, cfg) {
  const on = (v) => (v ? 'On' : 'Off');
  const lines = [
    `**Status** · ${cfg.enabled && cfg.channelId ? '🟢 On' : '🔴 Off'}`,
    `**Channel** · ${cfg.channelId ? `<#${cfg.channelId}>` : '—'}`,
    `**Image banner** · ${on(cfg.image)}${cfg.image ? (cfg.background ? ' (custom background)' : ' (aether background)') : ''}`,
    `**Ping new members** · ${cfg.ping ? 'Yes' : 'No'}`,
    `**Accent colour** · ${toHex(cfg.color ?? config.brand.color)}${cfg.color == null ? ' (brand)' : ''}`,
    `**Buttons** · ${[cfg.rulesChannelId && `📜 <#${cfg.rulesChannelId}>`, cfg.rolesChannelId && `🎭 <#${cfg.rolesChannelId}>`].filter(Boolean).join('  ') || '—'}`,
    `**Auto-role** · ${cfg.autoRoleId ? `<@&${cfg.autoRoleId}>` : '—'}`,
  ];
  const c = ui
    .container(cfg.color ?? config.brand.color)
    .addTextDisplayComponents(ui.text(`## 👋 Welcome settings\n${lines.join('\n')}`))
    .addSeparatorComponents(ui.divider())
    .addTextDisplayComponents(
      ui.text(
        `**Title** · ${truncate(cfg.title, 200)}\n**Banner subtitle** · ${truncate(cfg.imageSubtitle || '—', 120)}\n**Message**\n>>> ${truncate(cfg.message, 900)}`,
      ),
    )
    .addSeparatorComponents(ui.divider())
    .addTextDisplayComponents(
      ui.text(
        `-# Edit: ${ui.cmd(guild.id, 'welcome setup')} · ${ui.cmd(guild.id, 'welcome message')} · ${ui.cmd(guild.id, 'welcome image')} · ${ui.cmd(guild.id, 'welcome buttons')} · ${ui.cmd(guild.id, 'welcome autorole')} · ${ui.cmd(guild.id, 'welcome test')}`,
      ),
    );
  return { components: [c], flags: ui.V2, allowedMentions: { parse: [] } };
}

function messageModal(cfg) {
  const input = (id, style, max, required, value, placeholder) => {
    const t = new TextInputBuilder().setCustomId(id).setStyle(style).setMaxLength(max).setRequired(required);
    if (value) t.setValue(String(value).slice(0, max));
    if (placeholder) t.setPlaceholder(placeholder);
    return t;
  };
  return new ModalBuilder()
    .setCustomId('wl:msg')
    .setTitle('Welcome message')
    .addTextDisplayComponents(ui.text(`**Placeholders:** ${PLACEHOLDERS}`))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Title')
        .setDescription('Heading of the welcome card')
        .setTextInputComponent(input('title', TextInputStyle.Short, 200, true, cfg.title, '👋 Welcome to {server}!')),
      new LabelBuilder()
        .setLabel('Message')
        .setDescription('Markdown works — **bold**, lists, links, <#channel-id>')
        .setTextInputComponent(input('message', TextInputStyle.Paragraph, 2000, true, cfg.message)),
      new LabelBuilder()
        .setLabel('Banner subtitle (optional)')
        .setDescription('Small line under the name on the image banner')
        .setTextInputComponent(input('subtitle', TextInputStyle.Short, 80, false, cfg.imageSubtitle, 'Your bracket journey starts now')),
    );
}

async function replyWithPreview(interaction, cfg, title, body) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const header = ui.notice('success', title, body).components[0];
  const preview = await buildWelcomePayload(interaction.member, cfg, { preview: true });
  await interaction.editReply({
    components: [header, ui.text('-# 👀 Preview — this is what new members will see:'), ...preview.components],
    files: preview.files,
    flags: ui.V2,
    allowedMentions: { parse: [] },
  });
}

async function command(interaction) {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;
  const cfg = store.guild(guildId).welcome;

  switch (sub) {
    case 'setup': {
      const channel = interaction.options.getChannel('channel', true);
      assertBotChannelPerms(channel, ['ViewChannel', 'SendMessages', 'AttachFiles']);
      const image = interaction.options.getBoolean('image');
      const ping = interaction.options.getBoolean('ping');
      const color = resolveColor(interaction.options.getString('color'));
      cfg.channelId = channel.id;
      cfg.enabled = true;
      if (image !== null) cfg.image = image;
      if (ping !== null) cfg.ping = ping;
      if (color !== undefined) cfg.color = color;
      store.save(guildId);
      return replyWithPreview(
        interaction,
        cfg,
        'Welcome messages are on',
        `New members will be greeted in ${channel}.\n-# Customise the text with ${ui.cmd(guildId, 'welcome message')} · add Rules/Roles buttons with ${ui.cmd(guildId, 'welcome buttons')}`,
      );
    }

    case 'message':
      return interaction.showModal(messageModal(cfg));

    case 'buttons': {
      const rules = interaction.options.getChannel('rules_channel');
      const roles = interaction.options.getChannel('roles_channel');
      cfg.rulesChannelId = rules?.id ?? null;
      cfg.rolesChannelId = roles?.id ?? null;
      store.save(guildId);
      return replyWithPreview(
        interaction,
        cfg,
        'Welcome buttons updated',
        rules || roles ? 'Link buttons will appear under the welcome message.' : 'Buttons removed (run again with channels to add them).',
      );
    }

    case 'image': {
      const enabled = interaction.options.getBoolean('enabled', true);
      const bg = interaction.options.getAttachment('background');
      const reset = interaction.options.getBoolean('reset_background');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      cfg.image = enabled;
      if (reset) cfg.background = null;
      if (bg) {
        if (fileKind(bg.name, bg.contentType) !== 'image') throw new UserError('The background must be an image (PNG, JPG or WebP).');
        const buf = await download(bg.url, 25 * 1024 * 1024);
        const jpeg = await prepareBackground(buf).catch(() => {
          throw new UserError('I couldn’t read that image — try a PNG or JPG.');
        });
        cfg.background = jpeg.toString('base64');
      }
      store.save(guildId);
      return replyWithPreview(
        interaction,
        cfg,
        enabled ? 'Image banner is on' : 'Image banner is off',
        enabled
          ? `${cfg.background ? 'Using your custom background.' : 'Using the default aether background.'}\n-# Tip: 1200×480 images fit best.`
          : 'Welcome messages will use the clean text card with the member’s avatar.',
      );
    }

    case 'autorole': {
      const role = interaction.options.getRole('role');
      if (role) {
        const problem = selfAssignProblem(interaction.member, role);
        if (problem) throw new UserError(problem, 'Can’t use that role');
      }
      cfg.autoRoleId = role?.id ?? null;
      store.save(guildId);
      return ui.respond(
        interaction,
        role
          ? ui.notice('success', 'Auto-role set', `New members will automatically get ${role}.\n-# If Membership Screening is on, they get it after accepting the rules.`)
          : ui.notice('success', 'Auto-role off', 'New members won’t get a role automatically.'),
      );
    }

    case 'toggle': {
      const enabled = interaction.options.getBoolean('enabled', true);
      if (enabled && !cfg.channelId) {
        throw new UserError(`Pick a channel first with ${ui.cmd(guildId, 'welcome setup')}.`, 'No welcome channel yet');
      }
      cfg.enabled = enabled;
      store.save(guildId);
      return ui.respond(
        interaction,
        ui.notice(enabled ? 'success' : 'info', enabled ? 'Welcome messages on' : 'Welcome messages paused', enabled ? `Greeting new members in <#${cfg.channelId}>.` : 'Your settings are kept — turn it back on any time.'),
      );
    }

    case 'test': {
      const isPublic = interaction.options.getBoolean('public') ?? false;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (!isPublic) {
        const preview = await buildWelcomePayload(interaction.member, cfg, { preview: true });
        return interaction.editReply(preview);
      }
      if (!cfg.channelId) throw new UserError(`Set a welcome channel first with ${ui.cmd(guildId, 'welcome setup')}.`);
      const channel = await interaction.guild.channels.fetch(cfg.channelId).catch(() => null);
      if (!channel) throw new UserError('The welcome channel no longer exists — run /welcome setup again.');
      assertBotChannelPerms(channel, ['ViewChannel', 'SendMessages', 'AttachFiles']);
      const payload = await buildWelcomePayload(interaction.member, cfg, { preview: true });
      const msg = await channel.send(payload);
      autoReact.reactToOwnPost(msg);
      return interaction.editReply(
        ui.notice('success', 'Test welcome sent', `Posted in ${channel} (without pinging you).`, {
          buttons: [ui.button({ label: 'View message', emoji: '🔗', url: msg.url })],
        }),
      );
    }

    case 'settings':
      return ui.respond(interaction, settingsCard(interaction.guild, cfg));

    default:
      throw new UserError('Unknown option.');
  }
}

/** Modal submit for /welcome message */
async function onModal(interaction) {
  const cfg = store.guild(interaction.guildId).welcome;
  cfg.title = interaction.fields.getTextInputValue('title').trim() || cfg.title;
  cfg.message = interaction.fields.getTextInputValue('message').trim() || cfg.message;
  cfg.imageSubtitle = interaction.fields.getTextInputValue('subtitle').trim();
  store.save(interaction.guildId);
  return replyWithPreview(interaction, cfg, 'Welcome message saved', cfg.enabled ? null : `-# Welcome messages are currently off — turn them on with ${ui.cmd(interaction.guildId, 'welcome setup')}.`);
}

module.exports = { command, onModal, onMemberAdd, onMemberUpdate, buildWelcomePayload, PLACEHOLDERS };
