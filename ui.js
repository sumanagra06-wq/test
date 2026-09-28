'use strict';
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder,
} = require('discord.js');
const config = require('../config');

/**
 * Helpers for Discord "Components V2" — the modern message layout system
 * (containers, sections, text blocks, galleries) that replaces classic embeds.
 */

const V2 = MessageFlags.IsComponentsV2;
const EPHEMERAL = MessageFlags.Ephemeral;

const text = (content) => new TextDisplayBuilder().setContent(content);

const divider = (large = false) =>
  new SeparatorBuilder().setDivider(true).setSpacing(large ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small);

const spacer = (large = false) =>
  new SeparatorBuilder().setDivider(false).setSpacing(large ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small);

function container(color) {
  const c = new ContainerBuilder();
  if (color !== null && color !== undefined) c.setAccentColor(color);
  return c;
}

function thumbnail(url, description) {
  const t = new ThumbnailBuilder().setURL(url);
  if (description) t.setDescription(description.slice(0, 1024));
  return t;
}

function gallery(items) {
  return new MediaGalleryBuilder().addItems(
    items.map(({ url, description, spoiler }) => {
      const item = new MediaGalleryItemBuilder().setURL(url);
      if (description) item.setDescription(description.slice(0, 1024));
      if (spoiler) item.setSpoiler(true);
      return item;
    }),
  );
}

function button({ id, label, style = ButtonStyle.Secondary, emoji, url, disabled = false }) {
  const b = new ButtonBuilder();
  if (url) b.setStyle(ButtonStyle.Link).setURL(url);
  else b.setStyle(style).setCustomId(id);
  if (label) b.setLabel(String(label).slice(0, 80));
  if (emoji) b.setEmoji(emoji);
  if (disabled) b.setDisabled(true);
  return b;
}

const row = (...components) => new ActionRowBuilder().addComponents(components.flat());

const TONES = {
  success: { icon: '✅', color: config.colors.success },
  error: { icon: '⛔', color: config.colors.danger },
  warn: { icon: '⚠️', color: config.colors.warning },
  info: { icon: '💠', color: config.brand.color },
};

/**
 * A compact status card, e.g. notice('success', 'Role added', 'You now have @Valorant').
 * Returns a Components V2 payload (add EPHEMERAL with `ephemeral()` when replying).
 */
function notice(tone, title, body, { buttons = [] } = {}) {
  const t = TONES[tone] ?? TONES.info;
  const c = container(t.color).addTextDisplayComponents(text(`### ${t.icon}  ${title}${body ? `\n${body}` : ''}`));
  if (buttons.length) c.addActionRowComponents(row(buttons));
  return { components: [c], flags: V2, allowedMentions: { parse: [] } };
}

const ephemeral = (payload) => ({ ...payload, flags: (payload.flags ?? 0) | EPHEMERAL });

/** Adds a mixed list of blocks (text, gallery, separator, file, section, row) to a container in order. */
function fillContainer(c, blocks) {
  for (const b of blocks) {
    const type = b.data?.type ?? b.toJSON?.().type;
    switch (type) {
      case ComponentType.TextDisplay:
        c.addTextDisplayComponents(b);
        break;
      case ComponentType.MediaGallery:
        c.addMediaGalleryComponents(b);
        break;
      case ComponentType.Separator:
        c.addSeparatorComponents(b);
        break;
      case ComponentType.File:
        c.addFileComponents(b);
        break;
      case ComponentType.Section:
        c.addSectionComponents(b);
        break;
      case ComponentType.ActionRow:
        c.addActionRowComponents(b);
        break;
      default:
        throw new Error(`Unsupported block type ${type}`);
    }
  }
  return c;
}

/** Total characters of Text Display content in a payload (Discord caps this at 4000 per message). */
function textLength(components) {
  let total = 0;
  const walk = (node) => {
    if (!node) return;
    const json = typeof node.toJSON === 'function' ? node.toJSON() : node;
    if (json.type === ComponentType.TextDisplay) total += (json.content || '').length;
    for (const child of json.components ?? []) walk(child);
  };
  for (const c of components) walk(c);
  return total;
}

/* ─────────────── interaction response routing ─────────────── */

const updateDeferred = new WeakSet();

/** Use instead of interaction.deferUpdate() so error handling knows not to overwrite the message. */
function deferUpdate(interaction) {
  updateDeferred.add(interaction);
  return interaction.deferUpdate();
}

/**
 * Sends `payload` in the correct way for the interaction's state
 * (reply → editReply of a deferred reply → ephemeral follow-up).
 */
async function respond(interaction, payload) {
  const flagsNoEphemeral = (payload.flags ?? 0) & ~EPHEMERAL;
  if (!interaction.deferred && !interaction.replied) return interaction.reply(ephemeral(payload));
  if (interaction.deferred && !interaction.replied && !updateDeferred.has(interaction)) {
    return interaction.editReply({ ...payload, flags: flagsNoEphemeral });
  }
  return interaction.followUp(ephemeral(payload));
}

/**
 * Runs `work` and only defers the interaction if it's slow (> ~2s), so fast actions feel
 * instant while slow Discord API calls never hit the 3-second interaction timeout.
 */
async function autoDefer(interaction, work, { update = false, ms = 2200 } = {}) {
  let timer;
  const SLOW = Symbol('slow');
  const slow = new Promise((resolve) => {
    timer = setTimeout(resolve, ms, SLOW);
  });
  const first = await Promise.race([work.then(() => null, () => null), slow]);
  clearTimeout(timer);
  if (first === SLOW && !interaction.deferred && !interaction.replied) {
    if (update) await deferUpdate(interaction);
    else await interaction.deferReply({ flags: EPHEMERAL });
  }
  return work;
}

/** Updates the message a component lives on (works whether or not the interaction was deferred). */
function updateMessage(interaction, payload) {
  if (interaction.deferred || interaction.replied) return interaction.editReply({ ...payload, flags: (payload.flags ?? 0) & ~EPHEMERAL });
  return interaction.update({ ...payload, flags: (payload.flags ?? 0) & ~EPHEMERAL });
}

/* ─────────────── clickable command mentions ─────────────── */

const commandIds = new Map(); // guildId → Map(commandName → id)

function rememberCommands(guildId, commands) {
  const map = new Map();
  for (const c of commands.values()) map.set(c.name, c.id);
  commandIds.set(guildId, map);
}

/** Returns a clickable </command sub:id> mention (falls back to plain `/command`). */
function cmd(guildId, fullName) {
  const id = commandIds.get(guildId)?.get(fullName.split(' ')[0]);
  return id ? `</${fullName}:${id}>` : `\`/${fullName}\``;
}

module.exports = {
  V2,
  EPHEMERAL,
  text,
  divider,
  spacer,
  container,
  thumbnail,
  gallery,
  button,
  row,
  notice,
  ephemeral,
  fillContainer,
  textLength,
  deferUpdate,
  respond,
  autoDefer,
  updateMessage,
  rememberCommands,
  cmd,
  ButtonStyle,
};
