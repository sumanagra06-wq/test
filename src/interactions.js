'use strict';
const config = require('./config');
const log = require('./lib/log');
const ui = require('./lib/ui');
const { UserError, isDiscordHiccup, hiccupText } = require('./lib/utils');
const { NAMED_COLORS, parseColor, toHex } = require('./lib/color');
const announcements = require('./features/announcements');
const buttonRoles = require('./features/buttonRoles');
const reactionRoles = require('./features/reactionRoles');
const welcome = require('./features/welcome');
const help = require('./features/help');
const serverIds = require('./features/serverIds');
const autoReact = require('./features/autoReact');
const reactPicker = require('./features/reactPicker');
const reactTemplates = require('./features/reactTemplates');

const slashCommands = {
  announce: announcements.command,
  buttonroles: buttonRoles.command,
  reactionroles: reactionRoles.command,
  autoreact: autoReact.command,
  react: reactPicker.command,
  welcome: welcome.command,
  ids: serverIds.command,
  help: help.command,
};

const contextMenus = {
  'Post as Announcement': announcements.postAsAnnouncement,
  'Edit Announcement': announcements.editAnnouncement,
  'React as Bot': reactPicker.reactAsBot,
};

const modalHandlers = {
  an: announcements.onModal,
  br: buttonRoles.onModal,
  rr: reactionRoles.onModal,
  wl: welcome.onModal,
  ep: reactPicker.onModal,
};

const componentHandlers = {
  an: announcements.onButton,
  br: buttonRoles.onComponent,
  ids: serverIds.onComponent,
  ep: reactPicker.onComponent,
  rt: reactTemplates.onComponent,
};

function colorChoices(query) {
  const q = String(query || '').trim().toLowerCase();
  const out = [];
  if (/^(#|0x)?[0-9a-f]{3}([0-9a-f]{3})?$/.test(q)) {
    const c = parseColor(q);
    if (c !== null) out.push({ name: `Custom ${toHex(c)}`, value: toHex(c) });
  }
  if (!q || 'brand default'.includes(q)) out.push({ name: `Brand default (${toHex(config.brand.color)})`, value: 'brand' });
  for (const [name, value] of Object.entries(NAMED_COLORS)) {
    if (name === 'gray') continue;
    if (!q || name.includes(q)) out.push({ name: `${name[0].toUpperCase()}${name.slice(1)} · ${toHex(value)}`, value: name });
  }
  return out.slice(0, 25);
}

async function autocomplete(interaction) {
  const guild = interaction.guild;
  if (!guild) return interaction.respond([]);
  const focused = interaction.options.getFocused(true);
  let choices = [];
  if (focused.name === 'panel') choices = buttonRoles.panelChoices(guild, focused.value);
  else if (focused.name === 'message') choices = reactionRoles.messageChoices(guild, focused.value);
  else if (focused.name === 'name' && interaction.commandName === 'autoreact') choices = reactTemplates.templateChoices(guild, focused.value);
  else if (focused.name === 'emoji' && interaction.commandName === 'autoreact') {
    const channelId = interaction.options.get?.('channel')?.value ?? interaction.options.getChannel?.('channel')?.id;
    choices = autoReact.emojiChoices(guild, channelId, focused.value);
  } else if (focused.name === 'emoji') choices = reactionRoles.emojiChoices(guild, interaction.options.getString('message'), focused.value);
  else if (focused.name === 'ping') choices = announcements.pingChoices(guild, focused.value);
  else if (focused.name === 'color') choices = colorChoices(focused.value);
  return interaction.respond(choices.slice(0, 25));
}

/** Plain-English explanations for common Discord API errors. */
function explain(err) {
  switch (err?.code) {
    case 50013:
      return 'I’m missing a permission for that. Check my role’s permissions in that channel — and that my role is **above** the roles I manage.';
    case 50001:
      return 'I can’t see that channel. Give my role **View Channel** access.';
    case 10008:
      return 'That message no longer exists.';
    case 10011:
      return 'That role no longer exists.';
    case 40005:
      return 'The files are too large for this server’s upload limit.';
    case 50035:
      return `Discord rejected the content: ${String(err.rawError?.message || err.message).slice(0, 300)}`;
    case 30005:
      return 'This server has reached the maximum number of roles.';
    default:
      return 'Please try again. If it keeps happening, check the bot logs on your host.';
  }
}

function describe(interaction) {
  if (interaction.isChatInputCommand?.()) {
    const path = [interaction.options.getSubcommandGroup?.(false), interaction.options.getSubcommand(false)].filter(Boolean).join(' ');
    return `/${interaction.commandName} ${path}`.trim();
  }
  if (interaction.isCommand?.()) return interaction.commandName;
  return interaction.customId ?? 'interaction';
}

async function route(interaction) {
  if (interaction.isAutocomplete()) return autocomplete(interaction);
  if (!interaction.inCachedGuild()) {
    if (interaction.isRepliable()) await interaction.reply(ui.ephemeral(ui.notice('info', 'Server only', 'Use me inside a server.')));
    return;
  }
  if (interaction.isChatInputCommand()) return slashCommands[interaction.commandName]?.(interaction);
  if (interaction.isMessageContextMenuCommand()) return contextMenus[interaction.commandName]?.(interaction);
  const ns = interaction.customId?.split(':')[0];
  if (interaction.isModalSubmit()) return modalHandlers[ns]?.(interaction);
  if (interaction.isMessageComponent()) return componentHandlers[ns]?.(interaction); // buttons and every kind of dropdown
}

module.exports = async function handleInteraction(interaction) {
  try {
    await route(interaction);
  } catch (err) {
    if (interaction.isAutocomplete()) return log.warn('Autocomplete failed:', err.message);
    const where = describe(interaction);
    if (err?.code === 10062) return log.warn(`Interaction expired before I could answer (${where}).`);
    const expected = err instanceof UserError;
    const hiccup = !expected && isDiscordHiccup(err);
    // Discord's own servers failing (e.g. 503) is not a bot bug: one calm line instead of a stack trace
    if (hiccup) log.warn(`Discord had a temporary problem (${hiccupText(err)}) during ${where} — not a bot error; trying again usually works.`);
    else if (!expected) log.error(`Interaction failed (${where}):`, err);
    const payload = expected
      ? ui.notice('error', err.title, err.message)
      : hiccup
        ? ui.notice('error', 'Discord is having trouble', 'Discord’s servers didn’t respond in time. Please try again in a moment.')
        : ui.notice('error', 'Something went wrong', explain(err));
    await ui.respond(interaction, payload).catch((e) => {
      if (e?.code === 10062 || e?.code === 40060 || isDiscordHiccup(e)) {
        log.warn(`Couldn’t show the error message either — the interaction had already expired (${where}).`);
      } else log.error('Could not send the error message:', e.message);
    });
  }
};

module.exports.colorChoices = colorChoices;
