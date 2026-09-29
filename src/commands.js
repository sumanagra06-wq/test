'use strict';
const {
  ApplicationCommandType,
  ChannelType,
  ContextMenuCommandBuilder,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');

/**
 * Slash commands + right-click (context menu) commands.
 * Default permissions: staff only (server owners can change who sees them in
 * Server Settings → Integrations → the bot).
 */

const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

const colorOption = (o) => o.setName('color').setDescription('Accent colour — e.g. #7C5CFF, purple, gold, cyan').setAutocomplete(true).setMaxLength(20);

const panelOption = (o) => o.setName('panel').setDescription('Which panel').setAutocomplete(true).setRequired(true);

const messageOption = (o) =>
  o.setName('message').setDescription('Message link (right-click → Copy Message Link) or pick from the list').setAutocomplete(true).setRequired(true);

const announce = new SlashCommandBuilder()
  .setName('announce')
  .setDescription('Post an official announcement as the bot (with preview)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addChannelOption((o) => o.setName('channel').setDescription('Where to post it').addChannelTypes(...TEXT_CHANNELS).setRequired(true))
  .addStringOption((o) => o.setName('ping').setDescription('Ping @everyone, @here or a role').setAutocomplete(true))
  .addStringOption((o) =>
    o
      .setName('style')
      .setDescription('Look of the post')
      .addChoices({ name: 'Card — modern box with accent colour (default)', value: 'card' }, { name: 'Plain — clean text, no box', value: 'plain' }),
  )
  .addStringOption(colorOption)
  .addStringOption((o) =>
    o
      .setName('images')
      .setDescription('Where attached images appear')
      .addChoices({ name: 'Top — banner style (default)', value: 'top' }, { name: 'Bottom — after the text', value: 'bottom' }),
  )
  .addBooleanOption((o) => o.setName('crosspost').setDescription('Announcement channels only: also publish to following servers'));

const buttonroles = new SlashCommandBuilder()
  .setName('buttonroles')
  .setDescription('Modern button-role panels')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName('create')
      .setDescription('Create a new role panel')
      .addChannelOption((o) => o.setName('channel').setDescription('Where to post the panel').addChannelTypes(...TEXT_CHANNELS).setRequired(true))
      .addStringOption((o) =>
        o
          .setName('style')
          .setDescription('Layout of the panel')
          .addChoices(
            { name: 'List — a card per role with a button (up to 9)', value: 'list' },
            { name: 'Button grid — compact emoji buttons (up to 20)', value: 'buttons' },
            { name: 'Dropdown — overview + personal menu (up to 25)', value: 'dropdown' },
          ),
      )
      .addStringOption((o) =>
        o
          .setName('mode')
          .setDescription('How roles are given')
          .addChoices(
            { name: 'Toggle — add & remove freely (default)', value: 'toggle' },
            { name: 'One at a time — picking a role swaps the old one', value: 'unique' },
            { name: 'Add-only — members can’t remove roles', value: 'add' },
          ),
      )
      .addStringOption(colorOption)
      .addAttachmentOption((o) => o.setName('banner').setDescription('Optional banner image shown at the top')),
  )
  .addSubcommand((s) =>
    s
      .setName('add')
      .setDescription('Add a role to a panel — or update one that’s already there')
      .addStringOption(panelOption)
      .addRoleOption((o) => o.setName('role').setDescription('The role to give').setRequired(true))
      .addStringOption((o) => o.setName('emoji').setDescription('Emoji, e.g. 🎮 or a custom server emoji (“none” to clear)').setMaxLength(100))
      .addStringOption((o) => o.setName('label').setDescription('Text shown on the panel (default: role name)').setMaxLength(80))
      .addStringOption((o) => o.setName('description').setDescription('Short line under the role (“none” to clear)').setMaxLength(100))
      .addStringOption((o) =>
        o
          .setName('button_color')
          .setDescription('Button colour')
          .addChoices({ name: 'Grey', value: 'grey' }, { name: 'Blurple', value: 'blue' }, { name: 'Green', value: 'green' }, { name: 'Red', value: 'red' }),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('remove')
      .setDescription('Remove a role from a panel')
      .addStringOption(panelOption)
      .addRoleOption((o) => o.setName('role').setDescription('The role to remove').setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName('edit')
      .setDescription('Restyle a panel — or pick only the panel to edit its text')
      .addStringOption(panelOption)
      .addStringOption((o) =>
        o
          .setName('style')
          .setDescription('New layout')
          .addChoices({ name: 'List', value: 'list' }, { name: 'Button grid', value: 'buttons' }, { name: 'Dropdown', value: 'dropdown' }),
      )
      .addStringOption((o) =>
        o
          .setName('mode')
          .setDescription('New mode')
          .addChoices({ name: 'Toggle', value: 'toggle' }, { name: 'One at a time', value: 'unique' }, { name: 'Add-only', value: 'add' }),
      )
      .addStringOption(colorOption)
      .addAttachmentOption((o) => o.setName('banner').setDescription('New banner image'))
      .addBooleanOption((o) => o.setName('remove_banner').setDescription('Remove the banner image')),
  )
  .addSubcommand((s) =>
    s
      .setName('repost')
      .setDescription('Post a panel again (e.g. if it was deleted, or to move it)')
      .addStringOption(panelOption)
      .addChannelOption((o) => o.setName('channel').setDescription('New channel (default: same channel)').addChannelTypes(...TEXT_CHANNELS)),
  )
  .addSubcommand((s) => s.setName('delete').setDescription('Delete a panel and its message').addStringOption(panelOption))
  .addSubcommand((s) => s.setName('list').setDescription('Show all button-role panels'));

const reactionroles = new SlashCommandBuilder()
  .setName('reactionroles')
  .setDescription('Classic emoji reaction roles')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName('create')
      .setDescription('Post a reaction-role panel that lists its roles automatically')
      .addChannelOption((o) => o.setName('channel').setDescription('Where to post the panel').addChannelTypes(...TEXT_CHANNELS).setRequired(true))
      .addStringOption((o) =>
        o
          .setName('mode')
          .setDescription('How reactions work')
          .addChoices(
            { name: 'Normal — react to get, unreact to remove (default)', value: 'normal' },
            { name: 'One at a time — only one role from this panel', value: 'unique' },
            { name: 'Verify — reacting gives the role permanently', value: 'verify' },
          ),
      )
      .addStringOption(colorOption),
  )
  .addSubcommand((s) =>
    s
      .setName('add')
      .setDescription('Link an emoji to a role on a panel or ANY message')
      .addStringOption(messageOption)
      .addStringOption((o) => o.setName('emoji').setDescription('The emoji to react with').setRequired(true).setMaxLength(100))
      .addRoleOption((o) => o.setName('role').setDescription('Role to give').setRequired(true))
      .addStringOption((o) => o.setName('description').setDescription('Short line shown on bot panels').setMaxLength(100)),
  )
  .addSubcommand((s) =>
    s
      .setName('remove')
      .setDescription('Remove an emoji → role link')
      .addStringOption(messageOption)
      .addStringOption((o) => o.setName('emoji').setDescription('Which emoji').setRequired(true).setAutocomplete(true)),
  )
  .addSubcommand((s) =>
    s
      .setName('mode')
      .setDescription('Change how reactions work on a message')
      .addStringOption(messageOption)
      .addStringOption((o) =>
        o
          .setName('mode')
          .setDescription('New mode')
          .setRequired(true)
          .addChoices({ name: 'Normal', value: 'normal' }, { name: 'One at a time', value: 'unique' }, { name: 'Verify (permanent)', value: 'verify' }),
      ),
  )
  .addSubcommand((s) => s.setName('clear').setDescription('Remove all reaction roles from a message').addStringOption(messageOption))
  .addSubcommand((s) => s.setName('list').setDescription('Show all reaction-role messages'));

const welcome = new SlashCommandBuilder()
  .setName('welcome')
  .setDescription('Welcome new members')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName('setup')
      .setDescription('Turn on welcome messages in a channel')
      .addChannelOption((o) => o.setName('channel').setDescription('Welcome channel').addChannelTypes(...TEXT_CHANNELS).setRequired(true))
      .addBooleanOption((o) => o.setName('image').setDescription('Generated image banner (true) or clean text card (false)'))
      .addBooleanOption((o) => o.setName('ping').setDescription('Mention the new member (default: yes)'))
      .addStringOption(colorOption),
  )
  .addSubcommand((s) => s.setName('message').setDescription('Edit the welcome title, message and banner subtitle'))
  .addSubcommand((s) =>
    s
      .setName('image')
      .setDescription('Switch the image banner on/off or set a custom background')
      .addBooleanOption((o) => o.setName('enabled').setDescription('Use the generated image banner').setRequired(true))
      .addAttachmentOption((o) => o.setName('background').setDescription('Custom background image (1200×480 fits best)'))
      .addBooleanOption((o) => o.setName('reset_background').setDescription('Go back to the default aether background')),
  )
  .addSubcommand((s) =>
    s
      .setName('buttons')
      .setDescription('Link buttons under the welcome (leave empty to remove)')
      .addChannelOption((o) => o.setName('rules_channel').setDescription('📜 Rules button').addChannelTypes(...TEXT_CHANNELS, ChannelType.GuildForum))
      .addChannelOption((o) => o.setName('roles_channel').setDescription('🎭 Get roles button').addChannelTypes(...TEXT_CHANNELS, ChannelType.GuildForum)),
  )
  .addSubcommand((s) =>
    s
      .setName('autorole')
      .setDescription('Give new members a role automatically (leave empty to turn off)')
      .addRoleOption((o) => o.setName('role').setDescription('Role to give')),
  )
  .addSubcommand((s) =>
    s
      .setName('toggle')
      .setDescription('Pause or resume welcome messages')
      .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName('test')
      .setDescription('Preview the welcome message using yourself')
      .addBooleanOption((o) => o.setName('public').setDescription('Post it in the welcome channel instead of privately')),
  )
  .addSubcommand((s) => s.setName('settings').setDescription('Show the current welcome settings'));

const ids = new SlashCommandBuilder()
  .setName('ids')
  .setDescription('Every category, channel and role in this server with its ID')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild);

const help = new SlashCommandBuilder()
  .setName('help')
  .setDescription('What this bot can do')
  .setContexts(InteractionContextType.Guild);

const postAsAnnouncement = new ContextMenuCommandBuilder()
  .setName('Post as Announcement')
  .setType(ApplicationCommandType.Message)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild);

const editAnnouncement = new ContextMenuCommandBuilder()
  .setName('Edit Announcement')
  .setType(ApplicationCommandType.Message)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild);

const builders = [announce, buttonroles, reactionroles, welcome, ids, help, postAsAnnouncement, editAnnouncement];

module.exports = { builders, commands: builders.map((b) => b.toJSON()) };
