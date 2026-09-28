'use strict';
const http = require('node:http');
const {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  OAuth2Scopes,
  Partials,
  PermissionFlagsBits,
  PermissionsBitField,
} = require('discord.js');
const config = require('./config');
const store = require('./lib/store');
const log = require('./lib/log');
const ui = require('./lib/ui');
const { commands } = require('./commands');
const handleInteraction = require('./interactions');
const welcome = require('./features/welcome');
const reactionRoles = require('./features/reactionRoles');
const buttonRoles = require('./features/buttonRoles');
const announcements = require('./features/announcements');

if (!config.token) {
  log.error('DISCORD_TOKEN is missing. Add it to your environment variables (Railway → Variables) or a local .env file — see docs/1-setup-guide.md.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // privileged: enable "Server Members Intent" in the Developer Portal
    GatewayIntentBits.GuildMessages, // message delete events (no message content needed)
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildExpressions, // keeps custom emoji up to date
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User, Partials.GuildMember],
  allowedMentions: { parse: [] },
});

/** Everything the bot needs — used for the invite link printed at startup. */
const INVITE_PERMISSIONS = new PermissionsBitField([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.UseExternalEmojis,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.MentionEveryone,
]);

// `contexts` / `integration_types` only apply to global commands — strip them for per-server registration.
const guildCommands = commands.map(({ contexts, integration_types, ...rest }) => rest);

async function registerCommands(guild) {
  try {
    const registered = await guild.commands.set(guildCommands);
    ui.rememberCommands(guild.id, registered);
    log.info(`Slash commands ready in “${guild.name}”`);
  } catch (err) {
    log.error(`Could not register commands in ${guild.name}:`, err.message);
  }
}

const safe = (label, fn) => (...args) =>
  Promise.resolve()
    .then(() => fn(...args))
    .catch((err) => log.error(`${label} failed:`, err));

client.once(Events.ClientReady, async (c) => {
  log.info(`Logged in as ${c.user.tag} — in ${c.guilds.cache.size} server(s)`);
  c.user.setPresence({ activities: [{ name: config.status, type: ActivityType.Watching }], status: 'online' });
  for (const guild of c.guilds.cache.values()) await registerCommands(guild);
  const invite = c.generateInvite({ scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands], permissions: INVITE_PERMISSIONS });
  log.info(`Invite link: ${invite}`);
});

client.on(Events.GuildCreate, safe('Command registration', registerCommands));
client.on(Events.InteractionCreate, handleInteraction);
client.on(Events.GuildMemberAdd, safe('Welcome', welcome.onMemberAdd));
client.on(Events.GuildMemberUpdate, safe('Member update', welcome.onMemberUpdate));
client.on(Events.MessageReactionAdd, safe('Reaction add', reactionRoles.onReactionAdd));
client.on(Events.MessageReactionRemove, safe('Reaction remove', reactionRoles.onReactionRemove));

function onMessageGone(message) {
  if (!message.guildId) return;
  reactionRoles.onMessageDelete(message.guildId, message.id);
  buttonRoles.onMessageDelete(message.guildId, message.id);
  announcements.onMessageDelete(message.guildId, message.id);
}
client.on(Events.MessageDelete, safe('Message delete', onMessageGone));
client.on(Events.MessageBulkDelete, safe('Bulk delete', (messages) => messages.forEach(onMessageGone)));
client.on(
  Events.GuildRoleDelete,
  safe('Role delete', async (role) => {
    reactionRoles.onRoleDelete(role);
    await buttonRoles.onRoleDelete(role);
  }),
);
client.on(Events.Error, (err) => log.error('Client error:', err));
process.on('unhandledRejection', (err) => log.error('Unhandled rejection:', err));

/* Optional health-check endpoint (for hosts/uptime monitors that expect HTTP). */
if (config.port) {
  http
    .createServer((req, res) => {
      const ready = client.isReady();
      res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: ready ? 'online' : 'starting', guilds: client.guilds.cache.size, uptime: Math.round(process.uptime()) }));
    })
    .listen(config.port, '0.0.0.0', () => log.info(`Health check listening on port ${config.port}`));
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received — saving data and shutting down…`);
  await store.close();
  await client.destroy();
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

(async () => {
  await store.init();
  await client.login(config.token);
})().catch((err) => {
  if (err instanceof store.StorageError) {
    log.error(`Database problem: ${err.message}`);
  } else if (/disallowed intents|privileged intent/i.test(String(err?.message))) {
    log.error('Discord refused the connection: enable **Server Members Intent** in the Developer Portal → your app → Bot → Privileged Gateway Intents, then restart.');
  } else if (err?.code === 'TokenInvalid' || /token/i.test(String(err?.message))) {
    log.error('The DISCORD_TOKEN is invalid. Reset it in the Developer Portal → Bot → Reset Token and update your environment variable.');
  } else {
    log.error('Startup failed:', err);
  }
  process.exit(1);
});
