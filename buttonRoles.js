'use strict';
const path = require('node:path');
const {
  AttachmentBuilder,
  ButtonStyle,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  RoleSelectMenuBuilder,
  SectionBuilder,
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
const {
  UserError,
  truncate,
  shortId,
  parseEmoji,
  emojiText,
  emojiComponent,
  botRoleProblem,
  selfAssignProblem,
  assertBotChannelPerms,
  download,
  safeFileName,
  fileKind,
} = require('../lib/utils');

/**
 * Button-role panels built with Discord Components V2.
 *
 * Styles
 *  - list      → a card per role (text on the left, button on the right)   ≤ 9 roles
 *  - buttons   → a grid of emoji buttons                                    ≤ 20 roles
 *  - dropdown  → role overview + "Choose roles" opens a personal menu       ≤ 25 roles
 *  (panels automatically fall back to the next style if they grow too big)
 *
 * Modes
 *  - toggle → add & remove freely     - unique → one role at a time     - add → can't remove
 */

const LIST_MAX = 9;
const GRID_MAX = 20;
const MAX_ROLES = 25;
const MANAGER_LIST_MAX = 11;

const STYLE_LABEL = { list: 'List cards', buttons: 'Button grid', dropdown: 'Dropdown' };
const MODE_LABEL = { toggle: 'Toggle', unique: 'One at a time', add: 'Add-only' };
const BUTTON_COLORS = {
  grey: ButtonStyle.Secondary,
  blue: ButtonStyle.Primary,
  green: ButtonStyle.Success,
  red: ButtonStyle.Danger,
};
const ACTION_LABEL = { toggle: 'Get', unique: 'Pick', add: 'Claim' };

/** In-flight forms (slash options are remembered while the modal is open). */
const pending = new Map();
setInterval(() => {
  const cutoff = Date.now() - 20 * 60 * 1000;
  for (const [k, v] of pending) if (v.createdAt < cutoff) pending.delete(k);
}, 5 * 60 * 1000).unref();

/* ───────────────────────── helpers ───────────────────────── */

function effectiveStyle(panel) {
  const n = panel.roles.length;
  let style = panel.style || 'list';
  if (style === 'list' && n > LIST_MAX) style = 'buttons';
  if (style === 'buttons' && n > GRID_MAX) style = 'dropdown';
  return style;
}

function modeHint(mode, style) {
  if (style === 'dropdown') {
    return {
      toggle: 'Tap **Choose roles** to pick as many as you like.',
      unique: 'Tap **Choose roles** — you can hold one role from this panel.',
      add: 'Tap **Choose roles** to claim roles. Claimed roles are permanent here.',
    }[mode];
  }
  return {
    toggle: 'Tap a button to get a role · tap it again to remove it.',
    unique: 'You can hold one role from this panel — picking another swaps it.',
    add: 'Claimed roles are permanent here.',
  }[mode];
}

function resolveColor(input) {
  if (!input) return undefined;
  if (isDefaultColorKeyword(input)) return null;
  const c = parseColor(input);
  if (c === null) throw new UserError('Colours look like `#7C5CFF` or a name like `purple`, `gold`, `cyan`.', 'Invalid colour');
  return c;
}

function getPanel(guildId, input) {
  const panels = store.guild(guildId).buttonPanels;
  const key = String(input || '').trim();
  const panel =
    panels[key] ?? Object.values(panels).find((p) => p.title.toLowerCase() === key.toLowerCase());
  if (!panel) throw new UserError('I couldn’t find that panel — pick one from the list as you type.', 'Panel not found');
  return panel;
}

function roleEntry(role) {
  return {
    roleId: role.id,
    label: role.name,
    emoji: role.unicodeEmoji ? { id: null, name: role.unicodeEmoji, animated: false } : null,
    description: null,
    buttonColor: 'grey',
  };
}

const reason = (panel) => truncate(`Button roles · panel “${panel.title}”`, 400);

/* ───────────────────────── rendering ───────────────────────── */

/** The public panel message. */
function renderPanel(guild, panel) {
  const color = panel.color ?? config.brand.color;
  const style = effectiveStyle(panel);
  const c = ui.container(color);

  const bannerUrl = panel.bannerFile ? `attachment://${panel.bannerFile}` : panel.bannerUrl;
  if (bannerUrl) c.addMediaGalleryComponents(ui.gallery([{ url: bannerUrl, description: truncate(panel.title, 200) }]));

  const header = `# ${panel.title}${panel.description ? `\n${panel.description}` : ''}`;
  const icon = guild.iconURL?.({ extension: 'png', size: 256 });
  if (icon && !bannerUrl) {
    c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(ui.text(header)).setThumbnailAccessory(ui.thumbnail(icon, guild.name)));
  } else {
    c.addTextDisplayComponents(ui.text(header));
  }
  c.addSeparatorComponents(ui.divider(true));

  const roles = panel.roles;
  if (!roles.length) {
    c.addTextDisplayComponents(ui.text('-# ✨ Roles are being set up — check back soon!'));
  } else if (style === 'list') {
    for (const r of roles) {
      const e = r.emoji ? `${emojiText(r.emoji)}  ` : '';
      const desc = r.description ? `\n-# ${r.description}` : '';
      c.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(ui.text(`**${e}${r.label}**${desc}`))
          .setButtonAccessory(
            ui.button({
              id: `br:t:${panel.id}:${r.roleId}`,
              label: ACTION_LABEL[panel.mode] || 'Get',
              style: BUTTON_COLORS[r.buttonColor] ?? ButtonStyle.Secondary,
            }),
          ),
      );
    }
  } else if (style === 'buttons') {
    const legend = roles
      .filter((r) => r.description)
      .map((r) => `${r.emoji ? emojiText(r.emoji) : '▸'} **${r.label}** — ${r.description}`)
      .join('\n');
    if (legend) c.addTextDisplayComponents(ui.text(truncate(legend, 1800)));
    for (let i = 0; i < roles.length; i += 5) {
      c.addActionRowComponents(
        ui.row(
          roles.slice(i, i + 5).map((r) =>
            ui.button({
              id: `br:t:${panel.id}:${r.roleId}`,
              label: truncate(r.label, 80),
              emoji: emojiComponent(r.emoji),
              style: BUTTON_COLORS[r.buttonColor] ?? ButtonStyle.Secondary,
            }),
          ),
        ),
      );
    }
  } else {
    const lines = roles.map((r) => `${r.emoji ? emojiText(r.emoji) : '▸'}  <@&${r.roleId}>${r.description ? ` — ${r.description}` : ''}`);
    c.addTextDisplayComponents(ui.text(truncate(lines.join('\n'), 2500)));
  }

  c.addSeparatorComponents(ui.divider());
  if (roles.length) {
    c.addActionRowComponents(
      ui.row(
        style === 'dropdown'
          ? ui.button({ id: `br:me:${panel.id}`, label: 'Choose roles', emoji: '🎭', style: ButtonStyle.Primary })
          : ui.button({ id: `br:me:${panel.id}`, label: 'My roles', emoji: '👤' }),
      ),
    );
  }
  c.addTextDisplayComponents(ui.text(`-# ${panel.footer || modeHint(panel.mode, style)}`));
  return { components: [c], flags: ui.V2, allowedMentions: { parse: [] } };
}

/** The personal, ephemeral "My roles" manager — reflects the member's real roles live. */
function renderManager(guild, panel, have, status) {
  const c = ui.container(panel.color ?? config.brand.color);
  c.addTextDisplayComponents(ui.text(`## 👤 Your roles\n-# ${truncate(panel.title.replace(/[#*_`~]/g, ''), 80)} · changes apply instantly`));
  if (status) c.addTextDisplayComponents(ui.text(status));
  c.addSeparatorComponents(ui.divider());

  const useSelect = effectiveStyle(panel) === 'dropdown' || panel.roles.length > MANAGER_LIST_MAX;
  if (useSelect) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`br:ms:${panel.id}`)
      .setPlaceholder(panel.mode === 'unique' ? 'Pick one role…' : 'Select the roles you want…')
      .setMinValues(0)
      .setMaxValues(panel.mode === 'unique' ? 1 : panel.roles.length)
      .addOptions(
        panel.roles.map((r) => {
          const o = new StringSelectMenuOptionBuilder()
            .setLabel(truncate(r.label, 100))
            .setValue(r.roleId)
            .setDefault(have.has(r.roleId));
          if (r.description) o.setDescription(truncate(r.description, 100));
          if (r.emoji) o.setEmoji(emojiComponent(r.emoji));
          return o;
        }),
      );
    c.addActionRowComponents(ui.row(menu));
    const owned = panel.roles.filter((r) => have.has(r.roleId));
    c.addTextDisplayComponents(
      ui.text(owned.length ? `-# You have: ${owned.map((r) => `<@&${r.roleId}>`).join(' ')}` : '-# You don’t have any roles from this panel yet.'),
    );
  } else {
    for (const r of panel.roles) {
      const has = have.has(r.roleId);
      let btn;
      if (!has) {
        btn = ui.button({ id: `br:mt:${panel.id}:${r.roleId}`, label: panel.mode === 'unique' ? 'Pick' : 'Add', emoji: '➕', style: ButtonStyle.Success });
      } else if (panel.mode === 'add') {
        btn = ui.button({ id: `br:mt:${panel.id}:${r.roleId}`, label: 'Owned', emoji: '🔒', disabled: true });
      } else {
        btn = ui.button({ id: `br:mt:${panel.id}:${r.roleId}`, label: 'Remove', emoji: '✖️', style: ButtonStyle.Secondary });
      }
      const e = r.emoji ? `${emojiText(r.emoji)}  ` : '';
      c.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(ui.text(`${has ? '🟢' : '⚪'}  **${e}${r.label}**${r.description ? `\n-# ${r.description}` : ''}`))
          .setButtonAccessory(btn),
      );
    }
  }
  c.addSeparatorComponents(ui.divider());
  c.addTextDisplayComponents(ui.text(`-# ${managerHint(panel.mode, useSelect)}`));
  return { components: [c], flags: ui.V2, allowedMentions: { parse: [] } };
}

function managerHint(mode, useSelect) {
  if (useSelect) {
    return {
      toggle: 'Select the roles you want in the menu — deselect one to remove it.',
      unique: 'Pick one role in the menu — picking another swaps it.',
      add: 'Select roles to claim them — claimed roles are permanent here.',
    }[mode];
  }
  return {
    toggle: 'Tap **Add** or **Remove** to change your roles.',
    unique: 'You can hold one role from this panel — picking another swaps it.',
    add: 'Claimed roles are permanent here.',
  }[mode];
}

function resultStatus({ added = [], removed = [], locked = null, blocked = [] }) {
  const parts = [];
  if (added.length) parts.push(`✅ Added ${added.map((id) => `<@&${id}>`).join(' ')}`);
  if (removed.length) parts.push(`➖ Removed ${removed.map((id) => `<@&${id}>`).join(' ')}`);
  if (locked) parts.push(`🔒 <@&${locked}> can’t be removed from this panel`);
  if (blocked.length) parts.push(`⚠️ I can’t manage ${blocked.map((id) => `<@&${id}>`).join(' ')} — ask an admin to move my role higher`);
  return parts.length ? parts.join('\n') : '-# No changes.';
}

function resultCard(panel, result) {
  const { added = [], removed = [], locked } = result;
  let title;
  let color;
  if (added.length && removed.length) [title, color] = ['Role switched', config.brand.color];
  else if (added.length) [title, color] = ['Role added', config.colors.success];
  else if (removed.length) [title, color] = ['Role removed', 0x8b8fa3];
  else if (locked) [title, color] = ['Already yours', config.colors.warning];
  else [title, color] = ['No changes', 0x8b8fa3];
  const c = ui
    .container(color)
    .addTextDisplayComponents(ui.text(`### ${title}\n${resultStatus(result)}`))
    .addActionRowComponents(ui.row(ui.button({ id: `br:me:${panel.id}`, label: 'My roles', emoji: '👤' })));
  return { components: [c], flags: ui.V2 | MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
}

/* ───────────────────────── role changes ───────────────────────── */

/**
 * Applies one add/remove for a member, respecting the panel mode.
 * `have` (a Set of the member's role IDs) is updated in place.
 */
async function applyChange(member, panel, roleId, want, have) {
  const guild = member.guild;
  const role = guild.roles.cache.get(roleId);
  const problem = botRoleProblem(guild, role);
  if (problem) throw new UserError(problem, 'I can’t manage that role');

  if (want === 'remove') {
    if (!have.has(roleId)) return {};
    if (panel.mode === 'add') return { locked: roleId };
    await member.roles.remove(roleId, reason(panel));
    have.delete(roleId);
    return { removed: [roleId] };
  }

  if (have.has(roleId)) return {};
  if (panel.mode === 'unique') {
    const others = panel.roles
      .map((r) => r.roleId)
      .filter((id) => id !== roleId && have.has(id) && !botRoleProblem(guild, guild.roles.cache.get(id)));
    if (others.length) {
      const final = [...have].filter((id) => id !== guild.id && !others.includes(id));
      final.push(roleId);
      await member.roles.set(final, reason(panel));
      for (const id of others) have.delete(id);
      have.add(roleId);
      return { added: [roleId], removed: others };
    }
  }
  await member.roles.add(roleId, reason(panel));
  have.add(roleId);
  return { added: [roleId] };
}

function lookup(interaction, panelId, roleId) {
  const panel = store.guild(interaction.guildId).buttonPanels[panelId];
  if (!panel) throw new UserError('This role panel is no longer active.', 'Panel removed');
  if (roleId && !panel.roles.some((r) => r.roleId === roleId)) {
    throw new UserError('That role was removed from this panel.', 'Role unavailable');
  }
  return panel;
}

const memberRoleSet = (member) => new Set(member.roles.cache.keys());

/* ───────────────────────── component handlers ───────────────────────── */

async function onComponent(interaction) {
  const [, action, panelId, roleId] = interaction.customId.split(':');

  if (action === 't') {
    // public panel button → toggle, reply privately
    const panel = lookup(interaction, panelId, roleId);
    const have = memberRoleSet(interaction.member);
    const result = await ui.autoDefer(interaction, applyChange(interaction.member, panel, roleId, have.has(roleId) ? 'remove' : 'add', have));
    return ui.respond(interaction, resultCard(panel, result));
  }

  if (action === 'me') {
    const panel = lookup(interaction, panelId);
    if (!panel.roles.length) throw new UserError('This panel has no roles yet.', 'Nothing here yet');
    return interaction.reply(ui.ephemeral(renderManager(interaction.guild, panel, memberRoleSet(interaction.member))));
  }

  if (action === 'mt') {
    // manager toggle → update the private manager in place
    const panel = lookup(interaction, panelId, roleId);
    const have = memberRoleSet(interaction.member);
    const work = applyChange(interaction.member, panel, roleId, have.has(roleId) ? 'remove' : 'add', have);
    const result = await ui.autoDefer(interaction, work, { update: true });
    return ui.updateMessage(interaction, renderManager(interaction.guild, panel, have, resultStatus(result)));
  }

  if (action === 'ms') {
    // manager select → sync the member's roles with the selection
    const panel = lookup(interaction, panelId);
    const guild = interaction.guild;
    const member = interaction.member;
    const have = memberRoleSet(member);
    const selected = new Set(interaction.values);
    const ids = panel.roles.map((r) => r.roleId);
    let toAdd = ids.filter((id) => selected.has(id) && !have.has(id));
    let toRemove = ids.filter((id) => !selected.has(id) && have.has(id));
    let locked = null;
    if (panel.mode === 'add' && toRemove.length) {
      locked = toRemove[0];
      toRemove = [];
    }
    if (panel.mode === 'unique') {
      toAdd = toAdd.slice(0, 1);
      if (toAdd.length) toRemove = ids.filter((id) => id !== toAdd[0] && have.has(id));
    }
    const blocked = [...toAdd, ...toRemove].filter((id) => botRoleProblem(guild, guild.roles.cache.get(id)));
    toAdd = toAdd.filter((id) => !blocked.includes(id));
    toRemove = toRemove.filter((id) => !blocked.includes(id));
    if (toAdd.length || toRemove.length) {
      const final = [...have].filter((id) => id !== guild.id && !toRemove.includes(id)).concat(toAdd);
      await ui.autoDefer(interaction, member.roles.set([...new Set(final)], reason(panel)), { update: true });
      for (const id of toRemove) have.delete(id);
      for (const id of toAdd) have.add(id);
    }
    return ui.updateMessage(interaction, renderManager(guild, panel, have, resultStatus({ added: toAdd, removed: toRemove, locked, blocked })));
  }

  if (action === 'del') {
    // confirm deletion (admin)
    const panel = lookup(interaction, panelId);
    await ui.deferUpdate(interaction);
    await deletePanelMessage(interaction.guild, panel);
    delete store.guild(interaction.guildId).buttonPanels[panel.id];
    store.save(interaction.guildId);
    return interaction.editReply(ui.notice('success', 'Panel deleted', `**${truncate(panel.title, 100)}** and its message were removed.`));
  }

  if (action === 'keep') {
    return interaction.update(ui.notice('info', 'Kept the panel', 'Nothing was deleted.'));
  }

  throw new UserError('This button is outdated — try again.');
}

/* ───────────────────────── admin helpers ───────────────────────── */

/** Fetches the live panel message. Only a real "Unknown Channel/Message" counts as deleted —
 *  other errors (e.g. missing access) are thrown so they get a helpful explanation. */
async function fetchPanelMessage(guild, panel) {
  if (!panel.messageId) return { channel: null, message: null };
  const gone = (codes) => (err) => (codes.includes(err?.code) ? null : Promise.reject(err));
  const channel = await guild.channels.fetch(panel.channelId).catch(gone([10003]));
  if (!channel?.isTextBased()) return { channel: null, message: null };
  const message = await channel.messages.fetch(panel.messageId).catch(gone([10008]));
  return { channel, message };
}

async function deletePanelMessage(guild, panel) {
  const { message } = await fetchPanelMessage(guild, panel).catch(() => ({}));
  if (message) await message.delete().catch(() => {});
}

/** Banner files to (re)upload with the panel message. */
async function bannerFiles(panel, oldMessage, newBanner) {
  if (!panel.bannerFile) return [];
  if (newBanner) return [new AttachmentBuilder(newBanner, { name: panel.bannerFile })];
  const att =
    oldMessage?.attachments.find((a) => a.name === panel.bannerFile) ??
    oldMessage?.attachments.find((a) => fileKind(a.name, a.contentType) === 'image');
  if (!att) {
    panel.bannerFile = null; // banner lost — render without it
    return [];
  }
  const buf = await download(att.url, 100 * 1024 * 1024);
  return [new AttachmentBuilder(buf, { name: panel.bannerFile })];
}

/** Explains Discord API errors in plain words. */
function friendlyApiError(err) {
  const msg = String(err?.rawError?.message || err?.message || '');
  if (err?.code === 50035 && /emoji/i.test(JSON.stringify(err?.rawError?.errors || msg))) {
    return new UserError('Discord rejected an emoji. Custom emojis must be from a server I’m in — or use a normal emoji.', 'Invalid emoji');
  }
  if (err?.code === 50013) return new UserError('I’m missing permissions in that channel (View Channel, Send Messages, Attach Files).', 'Missing permissions');
  return err;
}

/** Re-renders the live panel message after a config change. */
async function refreshPanel(guild, panel, { newBanner } = {}) {
  const { channel, message } = await fetchPanelMessage(guild, panel);
  if (!channel || !message) {
    panel.messageId = null;
    throw new UserError(`The panel message was deleted — post it again with ${ui.cmd(guild.id, 'buttonroles repost')}.`, 'Panel message missing');
  }
  const files = await bannerFiles(panel, message, newBanner);
  const payload = renderPanel(guild, panel);
  try {
    await message.edit({ ...payload, files, attachments: [] });
  } catch (err) {
    throw friendlyApiError(err);
  }
}

function panelModal(customId, heading, values = {}, { withRoles = false } = {}) {
  const input = (id, style, max, required, value, placeholder) => {
    const t = new TextInputBuilder().setCustomId(id).setStyle(style).setMaxLength(max).setRequired(required);
    if (value) t.setValue(String(value).slice(0, max));
    if (placeholder) t.setPlaceholder(placeholder);
    return t;
  };
  const modal = new ModalBuilder().setCustomId(customId).setTitle(heading);
  modal.addLabelComponents(
    new LabelBuilder()
      .setLabel('Title')
      .setDescription('Big heading at the top of the panel')
      .setTextInputComponent(input('title', TextInputStyle.Short, 120, true, values.title, '🎮 Pick your games')),
    new LabelBuilder()
      .setLabel('Description (optional)')
      .setDescription('Markdown works — **bold**, lists, links')
      .setTextInputComponent(
        input('description', TextInputStyle.Paragraph, 1500, false, values.description, 'Grab the roles for the games you play to get pinged for brackets & scrims.'),
      ),
  );
  if (withRoles) {
    modal.addLabelComponents(
      new LabelBuilder()
        .setLabel('Roles')
        .setDescription('Pick up to 25 — add emoji & descriptions later with /buttonroles add')
        .setRoleSelectMenuComponent(new RoleSelectMenuBuilder().setCustomId('roles').setMinValues(0).setMaxValues(MAX_ROLES).setRequired(false)),
    );
  }
  modal.addLabelComponents(
    new LabelBuilder()
      .setLabel('Footer (optional)')
      .setDescription('Small text at the bottom (default: a usage hint)')
      .setTextInputComponent(input('footer', TextInputStyle.Short, 200, false, values.footer)),
  );
  return modal;
}

function panelSummary(guild, panel) {
  const style = effectiveStyle(panel);
  const fallback = style !== panel.style ? ` (shown as ${STYLE_LABEL[style]} — ${panel.roles.length} roles)` : '';
  return `**${STYLE_LABEL[panel.style]}**${fallback} · **${MODE_LABEL[panel.mode]}** · ${panel.roles.length}/${MAX_ROLES} roles · ID \`${panel.id}\``;
}

function jumpButton(guild, panel, label = 'Open panel') {
  if (!panel.messageId) return [];
  return [ui.button({ label, emoji: '🔗', url: `https://discord.com/channels/${guild.id}/${panel.channelId}/${panel.messageId}` })];
}

/* ───────────────────────── /buttonroles ───────────────────────── */

async function command(interaction) {
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;
  const g = store.guild(guild.id);

  if (sub === 'create') {
    const channel = interaction.options.getChannel('channel', true);
    assertBotChannelPerms(channel, ['ViewChannel', 'SendMessages', 'AttachFiles']);
    const banner = interaction.options.getAttachment('banner');
    if (banner && fileKind(banner.name, banner.contentType) !== 'image') {
      throw new UserError('The banner must be an image (PNG, JPG, GIF or WebP).');
    }
    const color = resolveColor(interaction.options.getString('color'));
    pending.set(interaction.id, {
      channelId: channel.id,
      style: interaction.options.getString('style') ?? 'list',
      mode: interaction.options.getString('mode') ?? 'toggle',
      color: color ?? null,
      banner: banner ? { url: banner.url, name: banner.name } : null,
      createdAt: Date.now(),
    });
    return interaction.showModal(panelModal(`br:create:${interaction.id}`, 'New button-role panel', {}, { withRoles: true }));
  }

  if (sub === 'add') {
    const panel = getPanel(guild.id, interaction.options.getString('panel', true));
    const role = interaction.options.getRole('role', true);
    const problem = selfAssignProblem(interaction.member, role);
    if (problem) throw new UserError(problem, 'Can’t use that role');

    const before = structuredClone(panel.roles);
    let entry = panel.roles.find((r) => r.roleId === role.id);
    const isNew = !entry;
    if (isNew) {
      if (panel.roles.length >= MAX_ROLES) throw new UserError(`A panel can hold up to ${MAX_ROLES} roles — create another panel for more.`);
      entry = roleEntry(role);
      panel.roles.push(entry);
    }
    const emojiIn = interaction.options.getString('emoji');
    if (emojiIn) {
      if (/^(none|remove|clear|-)$/i.test(emojiIn.trim())) entry.emoji = null;
      else {
        const e = parseEmoji(emojiIn, guild);
        if (!e) {
          panel.roles = before;
          throw new UserError('That doesn’t look like an emoji. Use a normal emoji (🎮) or a custom one from this server.', 'Invalid emoji');
        }
        entry.emoji = e;
      }
    }
    const label = interaction.options.getString('label');
    if (label) entry.label = truncate(label.trim(), 80);
    const description = interaction.options.getString('description');
    if (description) entry.description = /^(none|remove|clear|-)$/i.test(description.trim()) ? null : truncate(description.trim(), 100);
    const buttonColor = interaction.options.getString('button_color');
    if (buttonColor) entry.buttonColor = buttonColor;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      await refreshPanel(guild, panel);
    } catch (err) {
      panel.roles = before;
      throw err;
    }
    store.save(guild.id);
    const e = entry.emoji ? `${emojiText(entry.emoji)} ` : '';
    return interaction.editReply(
      ui.notice('success', isNew ? 'Role added to panel' : 'Role updated', `${e}**${entry.label}** → ${role}\n-# ${panelSummary(guild, panel)}`, {
        buttons: jumpButton(guild, panel),
      }),
    );
  }

  if (sub === 'remove') {
    const panel = getPanel(guild.id, interaction.options.getString('panel', true));
    const role = interaction.options.getRole('role', true);
    const before = structuredClone(panel.roles);
    if (!panel.roles.some((r) => r.roleId === role.id)) throw new UserError(`${role} isn’t on this panel.`);
    panel.roles = panel.roles.filter((r) => r.roleId !== role.id);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      await refreshPanel(guild, panel);
    } catch (err) {
      panel.roles = before;
      throw err;
    }
    store.save(guild.id);
    return interaction.editReply(ui.notice('success', 'Role removed from panel', `${role} is no longer on **${truncate(panel.title, 80)}**.\n-# Members keep the role — remove it manually if needed.`));
  }

  if (sub === 'edit') {
    const panel = getPanel(guild.id, interaction.options.getString('panel', true));
    const style = interaction.options.getString('style');
    const mode = interaction.options.getString('mode');
    const colorIn = interaction.options.getString('color');
    const banner = interaction.options.getAttachment('banner');
    const removeBanner = interaction.options.getBoolean('remove_banner');

    if (!style && !mode && !colorIn && !banner && !removeBanner) {
      // nothing but the panel chosen → open the text editor
      pending.set(interaction.id, { panelId: panel.id, createdAt: Date.now() });
      return interaction.showModal(panelModal(`br:edit:${interaction.id}`, 'Edit panel text', panel));
    }

    if (banner && fileKind(banner.name, banner.contentType) !== 'image') throw new UserError('The banner must be an image.');
    const color = resolveColor(colorIn);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const before = structuredClone(panel);
    let newBanner = null;
    if (style) panel.style = style;
    if (mode) panel.mode = mode;
    if (color !== undefined) panel.color = color;
    if (removeBanner) {
      panel.bannerFile = null;
      panel.bannerUrl = null;
    }
    if (banner) {
      newBanner = await download(banner.url, 100 * 1024 * 1024);
      panel.bannerFile = safeFileName(`banner${path.extname(banner.name) || '.png'}`);
      panel.bannerUrl = null;
    }
    try {
      await refreshPanel(guild, panel, { newBanner });
    } catch (err) {
      Object.assign(panel, before);
      throw err;
    }
    store.save(guild.id);
    return interaction.editReply(ui.notice('success', 'Panel updated', `**${truncate(panel.title, 80)}**\n-# ${panelSummary(guild, panel)}`, { buttons: jumpButton(guild, panel) }));
  }

  if (sub === 'repost') {
    const panel = getPanel(guild.id, interaction.options.getString('panel', true));
    const target = interaction.options.getChannel('channel') ?? (await guild.channels.fetch(panel.channelId).catch(() => null));
    if (!target) throw new UserError('The original channel is gone — choose a new `channel`.');
    assertBotChannelPerms(target, ['ViewChannel', 'SendMessages', 'AttachFiles']);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { message: old } = await fetchPanelMessage(guild, panel);
    const files = await bannerFiles(panel, old);
    let sent;
    try {
      sent = await target.send({ ...renderPanel(guild, panel), files });
    } catch (err) {
      throw friendlyApiError(err);
    }
    panel.channelId = target.id;
    panel.messageId = sent.id;
    store.save(guild.id);
    if (old) await old.delete().catch(() => {});
    return interaction.editReply(ui.notice('success', 'Panel reposted', `Now live in ${target}.`, { buttons: jumpButton(guild, panel) }));
  }

  if (sub === 'delete') {
    const panel = getPanel(guild.id, interaction.options.getString('panel', true));
    return interaction.reply(
      ui.ephemeral(
        ui.notice('warn', 'Delete this panel?', `**${truncate(panel.title, 100)}** (${panel.roles.length} roles) and its message will be removed.\n-# Members keep the roles they already have.`, {
          buttons: [
            ui.button({ id: `br:del:${panel.id}`, label: 'Delete panel', emoji: '🗑️', style: ButtonStyle.Danger }),
            ui.button({ id: `br:keep:${panel.id}`, label: 'Keep it' }),
          ],
        }),
      ),
    );
  }

  if (sub === 'list') {
    const panels = Object.values(g.buttonPanels);
    if (!panels.length) {
      return ui.respond(interaction, ui.notice('info', 'No button-role panels yet', `Create one with ${ui.cmd(guild.id, 'buttonroles create')}.`));
    }
    const lines = panels.slice(0, 20).map((p) => {
      const where = p.messageId ? `[#${guild.channels.cache.get(p.channelId)?.name ?? 'channel'}](https://discord.com/channels/${guild.id}/${p.channelId}/${p.messageId})` : '⚠️ message deleted — use repost';
      return `**${truncate(p.title, 70)}**\n-# ${where} · ${STYLE_LABEL[p.style]} · ${MODE_LABEL[p.mode]} · ${p.roles.length} roles · \`${p.id}\``;
    });
    const c = ui
      .container(config.brand.color)
      .addTextDisplayComponents(ui.text(`## 🎛️ Button-role panels\n${lines.join('\n')}`))
      .addSeparatorComponents(ui.divider())
      .addTextDisplayComponents(ui.text(`-# ${ui.cmd(guild.id, 'buttonroles add')} to add roles · ${ui.cmd(guild.id, 'buttonroles edit')} to restyle`));
    return ui.respond(interaction, { components: [c], flags: ui.V2, allowedMentions: { parse: [] } });
  }

  throw new UserError('Unknown option.');
}

/* ───────────────────────── modal submits ───────────────────────── */

const textField = (interaction, id) => {
  try {
    return interaction.fields.getTextInputValue(id).trim();
  } catch {
    return '';
  }
};

async function onModal(interaction) {
  const [, action, key] = interaction.customId.split(':');
  const p = pending.get(key);
  pending.delete(key);
  if (!p) throw new UserError('This form expired — please run the command again.', 'Form expired');
  const guild = interaction.guild;
  const g = store.guild(guild.id);

  if (action === 'create') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let roles = [];
    try {
      roles = [...(interaction.fields.getSelectedRoles('roles')?.values() ?? [])];
    } catch {
      roles = [];
    }
    const accepted = [];
    const skipped = [];
    for (const r of roles) {
      const role = guild.roles.cache.get(r.id);
      const problem = selfAssignProblem(interaction.member, role);
      if (problem) skipped.push(`• ${role ?? r.name}: ${problem}`);
      else accepted.push(role);
    }
    accepted.sort((a, b) => b.position - a.position);

    let id = shortId();
    while (g.buttonPanels[id]) id = shortId();
    const panel = {
      id,
      channelId: p.channelId,
      messageId: null,
      title: textField(interaction, 'title') || 'Choose your roles',
      description: textField(interaction, 'description'),
      footer: textField(interaction, 'footer'),
      color: p.color,
      style: p.style,
      mode: p.mode,
      bannerUrl: null,
      bannerFile: null,
      roles: accepted.slice(0, MAX_ROLES).map(roleEntry),
      createdBy: interaction.user.id,
      createdAt: Date.now(),
    };

    let newBanner = null;
    if (p.banner) {
      newBanner = await download(p.banner.url, 100 * 1024 * 1024);
      panel.bannerFile = safeFileName(`banner${path.extname(p.banner.name) || '.png'}`);
    }
    const channel = await guild.channels.fetch(p.channelId).catch(() => null);
    if (!channel) throw new UserError('That channel no longer exists.');
    let sent;
    try {
      sent = await channel.send({ ...renderPanel(guild, panel), files: await bannerFiles(panel, null, newBanner) });
    } catch (err) {
      throw friendlyApiError(err);
    }
    panel.messageId = sent.id;
    g.buttonPanels[panel.id] = panel;
    store.save(guild.id);

    const tips = [
      `Posted in ${channel} · ${panelSummary(guild, panel)}`,
      '',
      `**Next:** customise each role with ${ui.cmd(guild.id, 'buttonroles add')} — emoji, label, description and button colour.`,
    ];
    if (!panel.roles.length) tips.push('-# The panel shows “Roles are being set up” until you add roles.');
    if (skipped.length) tips.push('', '**Skipped:**', ...skipped.slice(0, 8));
    return interaction.editReply(ui.notice(skipped.length ? 'warn' : 'success', 'Panel published', truncate(tips.join('\n'), 3500), { buttons: jumpButton(guild, panel) }));
  }

  if (action === 'edit') {
    const panel = g.buttonPanels[p.panelId];
    if (!panel) throw new UserError('That panel no longer exists.');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const before = { title: panel.title, description: panel.description, footer: panel.footer };
    panel.title = textField(interaction, 'title') || panel.title;
    panel.description = textField(interaction, 'description');
    panel.footer = textField(interaction, 'footer');
    try {
      await refreshPanel(guild, panel);
    } catch (err) {
      Object.assign(panel, before);
      throw err;
    }
    store.save(guild.id);
    return interaction.editReply(ui.notice('success', 'Panel text updated', `**${truncate(panel.title, 100)}**`, { buttons: jumpButton(guild, panel) }));
  }

  throw new UserError('Unknown form.');
}

/* ───────────────────────── autocomplete & cleanup ───────────────────────── */

function panelChoices(guild, query) {
  const q = String(query || '').toLowerCase();
  return Object.values(store.guild(guild.id).buttonPanels)
    .filter((p) => !q || p.title.toLowerCase().includes(q) || p.id.includes(q))
    .slice(0, 25)
    .map((p) => ({
      name: truncate(`${p.title.replace(/[#*_`~]/g, '').trim()} · #${guild.channels.cache.get(p.channelId)?.name ?? '?'} · ${p.roles.length} roles`, 100),
      value: p.id,
    }));
}

function onMessageDelete(guildId, messageId) {
  const g = store.guilds[guildId];
  if (!g) return;
  for (const panel of Object.values(g.buttonPanels)) {
    if (panel.messageId === messageId) {
      panel.messageId = null; // keep config so it can be reposted
      store.save(guildId);
    }
  }
}

async function onRoleDelete(role) {
  const g = store.guilds[role.guild.id];
  if (!g) return;
  for (const panel of Object.values(g.buttonPanels)) {
    if (!panel.roles.some((r) => r.roleId === role.id)) continue;
    panel.roles = panel.roles.filter((r) => r.roleId !== role.id);
    store.save(role.guild.id);
    await refreshPanel(role.guild, panel).catch((err) => log.warn('Could not refresh panel after role deletion:', err.message));
  }
}

module.exports = {
  command,
  onComponent,
  onModal,
  panelChoices,
  onMessageDelete,
  onRoleDelete,
  renderPanel,
  renderManager,
  resultCard,
  effectiveStyle,
  STYLE_LABEL,
  MODE_LABEL,
};
