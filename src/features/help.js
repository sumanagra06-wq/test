'use strict';
const { SectionBuilder } = require('discord.js');
const config = require('../config');
const ui = require('../lib/ui');

function helpCard(guild, botUser) {
  const cmd = (name) => ui.cmd(guild.id, name);
  const c = ui.container(config.brand.color);
  c.addSectionComponents(
    new SectionBuilder()
      .addTextDisplayComponents(ui.text(`# ${config.brand.name} Bot\nRole panels, auto reactions, official announcements and welcomes.`))
      .setThumbnailAccessory(ui.thumbnail(botUser.displayAvatarURL({ extension: 'png', size: 256 }), 'Bot avatar')),
  );
  c.addSeparatorComponents(ui.divider(true));
  c.addTextDisplayComponents(
    ui.text(
      [
        '### 🎛️ Button roles',
        `${cmd('buttonroles create')} — new panel: pick roles, style & mode`,
        `${cmd('buttonroles add')} — add/customise a role (emoji, label, description, colour)`,
        `${cmd('buttonroles edit')} — restyle (list · grid · dropdown), recolour, banner or text`,
        `${cmd('buttonroles remove')} · ${cmd('buttonroles repost')} · ${cmd('buttonroles delete')} · ${cmd('buttonroles list')}`,
      ].join('\n'),
    ),
    ui.text(
      [
        '### 😀 Reaction roles',
        `${cmd('reactionroles create')} — panel that lists its roles automatically`,
        `${cmd('reactionroles add')} — emoji → role on a panel or **any** message`,
        `${cmd('reactionroles mode')} — normal · one at a time · verify`,
        `${cmd('reactionroles remove')} · ${cmd('reactionroles clear')} · ${cmd('reactionroles list')}`,
      ].join('\n'),
    ),
    ui.text(
      [
        '### ✨ Reactions',
        `${cmd('autoreact set')} — your server emojis on every new message in a channel (leave emojis empty to pick from a list)`,
        `${cmd('autoreact add')} · ${cmd('autoreact remove')} · ${cmd('autoreact list')}`,
        `${cmd('react')} — the bot reacts to any message (ID or link) with emojis picked from a list`,
        'Right-click any message → **Apps → React as Bot**',
      ].join('\n'),
    ),
    ui.text(
      [
        '### 📢 Announcements',
        `${cmd('announce')} — big composer (up to 8,000 characters + 10 files) with a private preview`,
        'Right-click any message → **Apps → Post as Announcement** — turns a draft (with files) into an official post',
        'Right-click an announcement → **Apps → Edit Announcement**',
      ].join('\n'),
    ),
    ui.text(
      [
        '### 👋 Welcome',
        `${cmd('welcome setup')} — channel, image banner on/off, ping, colour`,
        `${cmd('welcome message')} · ${cmd('welcome image')} · ${cmd('welcome buttons')} · ${cmd('welcome autorole')}`,
        `${cmd('welcome toggle')} · ${cmd('welcome test')} · ${cmd('welcome settings')}`,
      ].join('\n'),
    ),
    ui.text(['### 🗂️ Server IDs', `${cmd('ids')} — every category, channel and role with its ID (private, plus a .txt file)`].join('\n')),
  );
  c.addSeparatorComponents(ui.divider());
  c.addTextDisplayComponents(ui.text('-# 💡 My role must sit **above** every role I hand out (Server Settings → Roles).'));
  return { components: [c], flags: ui.V2, allowedMentions: { parse: [] } };
}

async function command(interaction) {
  return ui.respond(interaction, helpCard(interaction.guild, interaction.client.user));
}

module.exports = { command, helpCard };
