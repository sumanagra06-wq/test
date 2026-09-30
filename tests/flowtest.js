'use strict';
/**
 * Offline end-to-end test: drives every command, button, menu, form and event through the real
 * handlers against a mock Discord server, validating every message the bot would send.
 * Run with:  npm test
 */
process.env.DISCORD_TOKEN ||= 'flowtest';
process.env.DATA_DIR = require('node:path').join(require('node:os').tmpdir(), `ab-flowtest-${Date.now()}`);

const assert = require('node:assert/strict');
const http = require('node:http');
const { ChannelType, Collection, MessageFlags, MessageFlagsBitField, MessageType, PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const { createCanvas } = require('@napi-rs/canvas');
const { validatePayload, toJSON } = require('./helpers/validate');

const store = require('../src/lib/store');
const log = require('../src/lib/log');
const handleInteraction = require('../src/interactions');
const welcome = require('../src/features/welcome');
const reactionRoles = require('../src/features/reactionRoles');
const announcements = require('../src/features/announcements');
const autoReact = require('../src/features/autoReact');

/* fail on any unexpected error the bot logs */
const unexpected = [];
log.error = (...args) => unexpected.push(args.map(String).join(' '));
log.warn = () => {};
log.info = () => {};

let idSeq = 800000000000000000n;
const nextId = () => String(idSeq++);

/* ───────────── tiny file server (stands in for Discord's CDN) ───────────── */
const png = (() => {
  const c = createCanvas(600, 240);
  const x = c.getContext('2d');
  x.fillStyle = '#ff7a59';
  x.fillRect(0, 0, 600, 240);
  return c.toBuffer('image/png');
})();
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': req.url.endsWith('.pdf') ? 'application/pdf' : 'image/png' });
  res.end(png);
});

/* ───────────── mock server objects ───────────── */
const BOT_ID = '100000000000000002';
const GUILD_ID = '100000000000000001';
let base;

const role = (id, name, position, perms = 0n) => ({
  id,
  name,
  position,
  managed: false,
  mentionable: true,
  unicodeEmoji: null,
  permissions: new PermissionsBitField(perms),
  toString: () => `<@&${id}>`,
  comparePositionTo(other) {
    return this.position - other.position;
  },
});

const roles = new Collection();
const everyone = role(GUILD_ID, '@everyone', 0);
roles.set(GUILD_ID, everyone);
const R = {
  valorant: role('410000000000000001', 'Valorant', 10),
  rocket: role('410000000000000002', 'Rocket League', 9),
  chess: role('410000000000000003', 'Chess', 8),
  admin: role('410000000000000004', 'Admins', 20, PermissionFlagsBits.Administrator),
  high: role('410000000000000005', 'High Council', 60),
  member: role('410000000000000006', 'Member', 5),
};
for (const r of Object.values(R)) roles.set(r.id, r);
const botTop = role('410000000000000099', 'AetherBot', 80);

const sent = [];
const edits = [];
const reacts = [];
/** every send/edit in order: ['send' | 'edit', messageId] */
const events = [];

const guild = {
  id: GUILD_ID,
  name: 'AetherBrackets',
  ownerId: '100000000000000099',
  memberCount: 1284,
  iconURL: () => 'https://cdn.discordapp.com/embed/avatars/1.png',
  roles: { cache: roles, everyone },
  emojis: { cache: new Collection() },
  members: {},
  channels: { cache: new Collection() },
};
guild.channels.fetch = async (id) => guild.channels.cache.get(id) ?? null;
guild.members.me = {
  id: BOT_ID,
  permissions: new PermissionsBitField([PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageMessages]),
  roles: { highest: botTop },
};

function mockMessage(channel, payload, extra = {}) {
  const id = nextId();
  const attachmentsFrom = (files = []) =>
    new Collection(files.map((f, i) => [String(i), { name: f.name, url: `${base}/cdn/${f.name}`, contentType: 'image/png', size: png.length }]));
  const m = {
    id,
    channelId: channel.id,
    channel,
    guildId: GUILD_ID,
    guild,
    partial: false,
    author: { id: BOT_ID },
    content: '',
    url: `https://discord.com/channels/${GUILD_ID}/${channel.id}/${id}`,
    payload,
    sentPayload: payload, // what arrived first (payload changes on edits)
    flags: new MessageFlagsBitField(payload?.flags ?? 0), // like Discord: an edit can't remove "silent"
    attachments: attachmentsFrom(payload?.files),
    reactions: { cache: new Collection(), removeAll: async () => m.reactions.cache.clear() },
    async edit(p) {
      if (m.goneOnDiscord) throw Object.assign(new Error('Unknown Message'), { code: 10008, status: 404 });
      if (p.attachments && p.attachments.length === 0) m.attachments = attachmentsFrom(p.files);
      else if (p.files?.length) throw new Error('test: files on an edit without attachments: [] would pile up');
      m.payload = p;
      edits.push(p);
      events.push(['edit', id]);
      return m;
    },
    async delete() {
      channel._messages.delete(id);
      m.deleted = true;
    },
    async react(e) {
      reacts.push(e);
      (m.reacted ??= []).push(String(e));
      const key = String(e).match(/:(\d+)>$/)?.[1] ?? e;
      m.reactions.cache.set(key, { emoji: { id: null, name: e }, users: { remove: async () => {} }, remove: async () => {} });
    },
    async crosspost() {},
    ...extra,
  };
  return m;
}

function mockChannel(id, name, type = ChannelType.GuildText) {
  const ch = {
    id,
    name,
    type,
    guild,
    _messages: new Map(),
    isTextBased: () => true,
    toString: () => `<#${id}>`,
    permissionsFor: () => ({ has: () => true }),
    async send(payload) {
      const m = mockMessage(ch, payload);
      ch._messages.set(m.id, m);
      sent.push(m);
      events.push(['send', m.id]);
      return m;
    },
    messages: {
      fetch: async (arg) => {
        const { message: mid, force = false } = typeof arg === 'string' ? { message: arg } : arg;
        const m = ch._messages.get(mid);
        // goneOnDiscord = deleted on Discord, but the bot never got the event, so it's still in its cache
        if (!m || (m.goneOnDiscord && force)) throw Object.assign(new Error('Unknown Message'), { code: 10008, status: 404 });
        return m;
      },
    },
  };
  guild.channels.cache.set(id, ch);
  return ch;
}
const C = {
  roles: mockChannel('200000000000000001', 'roles'),
  news: mockChannel('200000000000000002', 'news', ChannelType.GuildAnnouncement),
  welcome: mockChannel('200000000000000003', 'welcome'),
  other: mockChannel('200000000000000004', 'other'),
};

function mockMember(id, roleIds = [], highest = 50) {
  const have = new Set(roleIds);
  const calls = [];
  const m = {
    id,
    guild,
    displayName: 'NovaStrike',
    pending: false,
    joinedTimestamp: Date.now(),
    user: { id, username: 'novastrike', bot: false },
    displayAvatarURL: () => `${base}/avatar.png`,
    calls,
    have,
    roles: {
      get cache() {
        return new Collection([GUILD_ID, ...have].map((r) => [r, roles.get(r) ?? { id: r }]));
      },
      highest: { position: highest, comparePositionTo: (r) => highest - r.position, toString: () => '<@&top>' },
      add: async (r) => {
        calls.push(['add', r?.id ?? r]);
        have.add(r?.id ?? r);
        return m;
      },
      remove: async (r) => {
        calls.push(['remove', r?.id ?? r]);
        have.delete(r?.id ?? r);
        return m;
      },
      set: async (arr) => {
        calls.push(['set', [...arr].sort()]);
        have.clear();
        for (const r of arr) if (r !== GUILD_ID) have.add(r);
        return m;
      },
    },
  };
  return m;
}
const admin = mockMember('100000000000000099', [R.admin.id], 70); // server owner
guild.members.fetch = async (id) => members.get(id);
const staff = mockMember('100000000000000098', [], 30); // moderator (not owner) — can't hand out roles above position 30
const members = new Map([[admin.id, admin], [staff.id, staff]]);

const botUser = { id: BOT_ID, displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' };
const client = { user: botUser, guilds: { fetch: async () => guild } };
guild.client = client;

/* ───────────── interaction factory ───────────── */
function interaction({ type, commandName, sub, options = {}, customId, fields = {}, values, targetMessage, member = admin, fromMessage = false }) {
  const i = {
    id: nextId(),
    type,
    guildId: GUILD_ID,
    guild,
    channelId: C.roles.id,
    channel: C.roles,
    member,
    user: member.user,
    client,
    commandName,
    customId,
    values,
    targetMessage,
    deferred: false,
    replied: false,
    log: [],
    inCachedGuild: () => true,
    isRepliable: () => true,
    isAutocomplete: () => type === 'autocomplete',
    isChatInputCommand: () => type === 'slash',
    isMessageContextMenuCommand: () => type === 'context',
    isCommand: () => type === 'slash' || type === 'context',
    isModalSubmit: () => type === 'modal',
    isButton: () => type === 'button',
    isStringSelectMenu: () => type === 'select',
    isFromMessage: () => fromMessage,
    options: {
      getSubcommand: () => sub,
      getChannel: (n) => options[n] ?? null,
      getString: (n) => options[n] ?? null,
      getRole: (n) => options[n] ?? null,
      getBoolean: (n) => options[n] ?? null,
      getAttachment: (n) => options[n] ?? null,
      getFocused: () => ({ name: options.focused, value: options[options.focused] ?? '' }),
    },
    fields: {
      getTextInputValue: (id) => fields[id] ?? '',
      getSelectedRoles: (id) => (fields[id] ? new Collection(fields[id].map((r) => [r.id, r])) : null),
      getUploadedFiles: (id) => (fields[id]?.length ? new Collection(fields[id].map((a, k) => [String(k), a])) : null),
      getSelectedChannels: (id) => (fields[id] ? new Collection([[fields[id].id, fields[id]]]) : null),
      getStringSelectValues: (id) => fields[id] ?? [],
    },
    async reply(p) {
      i.replied = true;
      i.log.push(['reply', p]);
    },
    async deferReply() {
      i.deferred = true;
      i.log.push(['deferReply']);
    },
    async deferUpdate() {
      i.deferred = true;
      i.log.push(['deferUpdate']);
    },
    async editReply(p) {
      i.replied = true;
      i.log.push(['editReply', p]);
    },
    async followUp(p) {
      i.log.push(['followUp', p]);
    },
    async update(p) {
      i.replied = true;
      i.log.push(['update', p]);
    },
    async showModal(m) {
      i.replied = true;
      i.log.push(['showModal', m.toJSON()]);
    },
    async respond(c) {
      i.log.push(['respond', c]);
    },
  };
  return i;
}

const texts = (payload) => JSON.stringify((payload?.components ?? []).map(toJSON));
const pingLine = (payload) => toJSON(payload.components[0]).content;
const isSilent = (payload) => Boolean(payload.flags & MessageFlags.SuppressNotifications);

/** Runs an interaction and returns the final response; asserts no unexpected errors. */
async function run(name, spec, { expectError = false } = {}) {
  const i = interaction(spec);
  await handleInteraction(i);
  if (unexpected.length) throw new Error(`${name}: unexpected error → ${unexpected.join('\n')}`);
  const last = [...i.log].reverse().find(([k]) => ['reply', 'editReply', 'update', 'followUp', 'showModal', 'respond'].includes(k));
  assert.ok(last, `${name}: no response`);
  const [kind, payload] = last;
  if (kind !== 'showModal' && kind !== 'respond') {
    validatePayload(name, payload);
    const isError = texts(payload).includes('⛔');
    if (expectError) assert.ok(isError, `${name}: expected an error message`);
    else assert.ok(!isError, `${name}: got error → ${texts(payload).slice(0, 400)}`);
  }
  return { i, kind, payload };
}

let passed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n`, err);
    process.exitCode = 1;
    unexpected.length = 0;
  }
}

/* ───────────── flows ───────────── */
(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await store.init();
  const g = () => store.guild(GUILD_ID);
  const att = (name, contentType = 'image/png') => ({ url: `${base}/up/${name}`, name, contentType, size: png.length });

  console.log('Button roles');
  let panelId;
  await step('/buttonroles create → form', async () => {
    const { kind, payload, i } = await run('create', {
      type: 'slash',
      commandName: 'buttonroles',
      sub: 'create',
      options: { channel: C.roles, style: 'list', mode: 'toggle', color: 'gold', banner: att('Cool Banner.png') },
    });
    assert.equal(kind, 'showModal');
    assert.equal(payload.custom_id, `br:create:${i.id}`);
    // submit the form
    const res = await run('create submit', {
      type: 'modal',
      customId: payload.custom_id,
      fields: { title: '🎮 Pick your games', description: 'Get pinged for brackets.', footer: '', roles: [R.valorant, R.rocket, R.admin, R.high] },
      member: staff,
    });
    const txt = texts(res.payload);
    assert.ok(txt.includes('Skipped'), 'dangerous/higher roles should be skipped');
    assert.ok(txt.includes('powerful permissions') && txt.includes('below'), 'both skip reasons shown');
    panelId = Object.keys(g().buttonPanels)[0];
    const panel = g().buttonPanels[panelId];
    assert.equal(panel.roles.length, 2);
    assert.equal(panel.color, 0xf5b301);
    assert.equal(panel.bannerFile, 'banner.png');
    const msg = sent.at(-1);
    assert.equal(msg.id, panel.messageId);
    assert.equal(msg.payload.files.length, 1);
    validatePayload('panel message', msg.payload, { ephemeralOk: false });
  });

  await step('/buttonroles add (emoji, label, description, colour) re-uploads banner', async () => {
    const before = edits.length;
    await run('add', {
      type: 'slash',
      commandName: 'buttonroles',
      sub: 'add',
      options: { panel: panelId, role: R.chess, emoji: '♟️', label: 'Chess', description: 'Weekly blitz brackets', button_color: 'blue' },
    });
    assert.equal(edits.length, before + 1);
    const e = edits.at(-1);
    assert.deepEqual(e.attachments, []);
    assert.equal(e.files[0].name, 'banner.png');
    validatePayload('panel after add', e, { ephemeralOk: false });
    assert.equal(g().buttonPanels[panelId].roles.length, 3);
  });

  await step('/buttonroles add rejects Administrator role', async () => {
    await run('add admin', { type: 'slash', commandName: 'buttonroles', sub: 'add', options: { panel: panelId, role: R.admin } }, { expectError: true });
  });

  const user = mockMember('700000000000000001', [R.member.id], 5);
  members.set(user.id, user);
  await step('member taps Get → role added, taps again → removed', async () => {
    let r = await run('toggle add', { type: 'button', customId: `br:t:${panelId}:${R.valorant.id}`, member: user });
    assert.ok(texts(r.payload).includes('Role added'));
    assert.ok(user.have.has(R.valorant.id));
    r = await run('toggle remove', { type: 'button', customId: `br:t:${panelId}:${R.valorant.id}`, member: user });
    assert.ok(texts(r.payload).includes('Role removed'));
    assert.ok(!user.have.has(R.valorant.id));
  });

  await step('My roles manager → toggle in place', async () => {
    let r = await run('manager', { type: 'button', customId: `br:me:${panelId}`, member: user });
    assert.equal(r.kind, 'reply');
    r = await run('manager toggle', { type: 'button', customId: `br:mt:${panelId}:${R.rocket.id}`, member: user });
    assert.equal(r.kind, 'update');
    assert.ok(user.have.has(R.rocket.id));
    assert.ok(texts(r.payload).includes('Remove'));
  });

  await step('slow Discord API → auto "thinking…" then result (no timeout)', async () => {
    const realAdd = user.roles.add;
    user.roles.add = async (r) => {
      await new Promise((res) => setTimeout(res, 2600));
      return realAdd(r);
    };
    const r = await run('slow toggle', { type: 'button', customId: `br:t:${panelId}:${R.chess.id}`, member: user });
    user.roles.add = realAdd;
    assert.ok(r.i.log.some(([k]) => k === 'deferReply'), 'should defer when slow');
    assert.equal(r.kind, 'editReply');
    assert.ok(texts(r.payload).includes('Role added'));
    await run('undo', { type: 'button', customId: `br:t:${panelId}:${R.chess.id}`, member: user });
  });

  await step('mode → one at a time swaps roles', async () => {
    await run('edit mode', { type: 'slash', commandName: 'buttonroles', sub: 'edit', options: { panel: panelId, mode: 'unique' } });
    const r = await run('unique swap', { type: 'button', customId: `br:t:${panelId}:${R.chess.id}`, member: user });
    assert.ok(texts(r.payload).includes('Role switched'));
    assert.ok(user.have.has(R.chess.id) && !user.have.has(R.rocket.id) && user.have.has(R.member.id));
  });

  await step('dropdown style + personal select syncs roles', async () => {
    await run('edit style', { type: 'slash', commandName: 'buttonroles', sub: 'edit', options: { panel: panelId, style: 'dropdown', mode: 'toggle' } });
    const r = await run('select sync', { type: 'select', customId: `br:ms:${panelId}`, values: [R.valorant.id, R.rocket.id], member: user });
    assert.equal(r.kind, 'update');
    assert.ok(user.have.has(R.valorant.id) && user.have.has(R.rocket.id) && !user.have.has(R.chess.id) && user.have.has(R.member.id));
  });

  await step('add-only mode keeps roles', async () => {
    await run('edit add-only', { type: 'slash', commandName: 'buttonroles', sub: 'edit', options: { panel: panelId, mode: 'add' } });
    const r = await run('locked', { type: 'button', customId: `br:t:${panelId}:${R.valorant.id}`, member: user });
    assert.ok(texts(r.payload).includes('Already yours'));
    assert.ok(user.have.has(R.valorant.id));
  });

  await step('/buttonroles edit (text form) + remove banner + recolour', async () => {
    const { payload } = await run('edit text', { type: 'slash', commandName: 'buttonroles', sub: 'edit', options: { panel: panelId } });
    assert.equal(payload.custom_id.split(':')[1], 'edit');
    await run('edit text submit', { type: 'modal', customId: payload.custom_id, fields: { title: '🕹️ Game roles', description: 'Updated', footer: 'AetherBrackets' } });
    assert.equal(g().buttonPanels[panelId].title, '🕹️ Game roles');
    await run('remove banner', { type: 'slash', commandName: 'buttonroles', sub: 'edit', options: { panel: panelId, remove_banner: true, color: '#22d3ee', style: 'buttons' } });
    assert.equal(edits.at(-1).files.length, 0);
  });

  await step('/buttonroles repost to another channel', async () => {
    const oldId = g().buttonPanels[panelId].messageId;
    await run('repost', { type: 'slash', commandName: 'buttonroles', sub: 'repost', options: { panel: panelId, channel: C.other } });
    const p = g().buttonPanels[panelId];
    assert.equal(p.channelId, C.other.id);
    assert.notEqual(p.messageId, oldId);
    assert.ok(!C.roles._messages.has(oldId));
  });

  await step('/buttonroles list + autocomplete + remove', async () => {
    await run('list', { type: 'slash', commandName: 'buttonroles', sub: 'list' });
    const { payload } = await run('autocomplete', { type: 'autocomplete', commandName: 'buttonroles', options: { focused: 'panel', panel: 'game' } });
    assert.equal(payload[0].value, panelId);
    await run('remove', { type: 'slash', commandName: 'buttonroles', sub: 'remove', options: { panel: panelId, role: R.chess } });
    assert.equal(g().buttonPanels[panelId].roles.length, 2);
  });

  await step('/buttonroles delete → confirm', async () => {
    const { payload } = await run('delete', { type: 'slash', commandName: 'buttonroles', sub: 'delete', options: { panel: panelId } });
    assert.ok(texts(payload).includes(`br:del:${panelId}`));
    await run('confirm delete', { type: 'button', customId: `br:del:${panelId}` });
    assert.equal(g().buttonPanels[panelId], undefined);
  });

  console.log('Reaction roles');
  let rrMessage;
  await step('/reactionroles create → panel posted', async () => {
    const { payload } = await run('rr create', { type: 'slash', commandName: 'reactionroles', sub: 'create', options: { channel: C.roles, mode: 'normal', color: 'pink' } });
    await run('rr create submit', { type: 'modal', customId: payload.custom_id, fields: { title: '😀 React for roles', description: 'Pick your games' } });
    rrMessage = sent.at(-1);
    assert.ok(g().reactionRoles[rrMessage.id]);
  });

  await step('/reactionroles add (unicode + custom emoji) reacts & re-renders', async () => {
    const ref = `${C.roles.id}-${rrMessage.id}`;
    await run('rr add', { type: 'slash', commandName: 'reactionroles', sub: 'add', options: { message: ref, emoji: '🎮', role: R.valorant, description: 'Valorant pings' } });
    await run('rr add 2', { type: 'slash', commandName: 'reactionroles', sub: 'add', options: { message: rrMessage.url, emoji: '<:rl:123456789012345678>', role: R.rocket } });
    assert.equal(g().reactionRoles[rrMessage.id].entries.length, 2);
    assert.deepEqual(reacts.slice(-2), ['🎮', '<:rl:123456789012345678>']);
    assert.ok(JSON.stringify(rrMessage.payload.components.map(toJSON)).includes(R.valorant.id));
  });

  const reactor = mockMember('700000000000000002', [], 1);
  members.set(reactor.id, reactor);
  const reaction = (emoji) => ({ message: rrMessage, emoji, client, users: { remove: async () => {} } });
  await step('reaction add/remove gives & takes the role', async () => {
    await reactionRoles.onReactionAdd(reaction({ id: null, name: '🎮' }), { id: reactor.id });
    assert.ok(reactor.have.has(R.valorant.id));
    await reactionRoles.onReactionRemove(reaction({ id: null, name: '🎮' }), { id: reactor.id });
    assert.ok(!reactor.have.has(R.valorant.id));
    await reactionRoles.onReactionAdd(reaction({ id: '123456789012345678', name: 'rl' }), { id: reactor.id });
    assert.ok(reactor.have.has(R.rocket.id));
  });

  await step('unique mode swaps, verify mode keeps', async () => {
    await run('rr mode', { type: 'slash', commandName: 'reactionroles', sub: 'mode', options: { message: rrMessage.url, mode: 'unique' } });
    await reactionRoles.onReactionAdd(reaction({ id: null, name: '🎮' }), { id: reactor.id });
    assert.ok(reactor.have.has(R.valorant.id) && !reactor.have.has(R.rocket.id));
    await run('rr mode verify', { type: 'slash', commandName: 'reactionroles', sub: 'mode', options: { message: rrMessage.url, mode: 'verify' } });
    await reactionRoles.onReactionRemove(reaction({ id: null, name: '🎮' }), { id: reactor.id });
    assert.ok(reactor.have.has(R.valorant.id), 'verify mode must keep the role');
  });

  await step('/reactionroles list, remove (autocomplete), clear', async () => {
    await run('rr list', { type: 'slash', commandName: 'reactionroles', sub: 'list' });
    const { payload } = await run('rr emoji ac', { type: 'autocomplete', commandName: 'reactionroles', options: { focused: 'emoji', emoji: '', message: `${C.roles.id}-${rrMessage.id}` } });
    assert.equal(payload.length, 2);
    await run('rr remove', { type: 'slash', commandName: 'reactionroles', sub: 'remove', options: { message: rrMessage.url, emoji: payload[1].value } });
    assert.equal(g().reactionRoles[rrMessage.id].entries.length, 1);
    await run('rr clear', { type: 'slash', commandName: 'reactionroles', sub: 'clear', options: { message: rrMessage.url } });
    assert.equal(g().reactionRoles[rrMessage.id], undefined);
  });

  console.log('Announcements');
  let announcement;
  await step('/announce → form → preview → style → edit → publish', async () => {
    const { payload } = await run('announce', { type: 'slash', commandName: 'announce', options: { channel: C.news, ping: 'everyone', crosspost: true } });
    assert.equal(payload.components.length, 5);
    const preview = await run('announce submit', {
      type: 'modal',
      customId: payload.custom_id,
      fields: { title: 'Season 3 is here', body: 'Registrations are **open**!', more: '', footer: '— The AetherBrackets Team', files: [att('poster.png'), att('Rules v2.pdf', 'application/pdf')] },
    });
    assert.equal(preview.payload.files.length, 2);
    const sid = payload.custom_id.split(':')[2];
    let r = await run('style toggle', { type: 'button', customId: `an:style:${sid}`, fromMessage: true });
    assert.deepEqual(r.payload.attachments, []);
    r = await run('edit button', { type: 'button', customId: `an:edit:${sid}`, fromMessage: true });
    assert.equal(r.kind, 'showModal');
    await run('edit submit', { type: 'modal', customId: `an:upd:${sid}`, fromMessage: true, fields: { title: 'Season 3 is HERE', body: 'Registrations are **open** until Friday!', footer: '— Staff' } });
    const count = sent.length;
    r = await run('publish', { type: 'button', customId: `an:pub:${sid}`, fromMessage: true });
    assert.ok(texts(r.payload).includes('Announcement published'));
    assert.equal(sent.length, count + 1);
    announcement = sent.at(-1);
    assert.deepEqual(announcement.payload.allowedMentions, { parse: ['users', 'everyone'] });
    assert.equal(announcement.payload.files.length, 2);
    validatePayload('published', announcement.payload, { ephemeralOk: false });
    assert.ok(g().announcements[announcement.id]);
  });

  await step('Edit Announcement (longer text → extra parts, files carried over)', async () => {
    const { payload } = await run('edit ctx', { type: 'context', commandName: 'Edit Announcement', targetMessage: announcement });
    const long = 'A long paragraph about the new season. '.repeat(100);
    const editsBefore = edits.length;
    const sentBefore = sent.length;
    const r = await run('edit ctx submit', { type: 'modal', customId: payload.custom_id, fields: { title: 'Season 3 is HERE', body: long, more: long, footer: '' } });
    const rec = g().announcements[announcement.id];
    assert.ok(rec.messageIds.length >= 2, 'long edit should span multiple messages');
    assert.equal(rec.files.length, 2);
    // edits keep the ping + its mentions (so the gold highlight stays; edits never notify)
    assert.ok(edits.length > editsBefore);
    for (const p of edits.slice(editsBefore)) {
      assert.deepEqual(p.allowedMentions, { parse: ['users', 'everyone'] }, 'edits must keep the mentions');
      assert.equal(isSilent(p), false, 'edits never carry the silent flag');
    }
    assert.equal(pingLine(announcement.payload), '@everyone', 'part 1 keeps the ping');
    // parts the edit had to add arrive quiet (nobody is notified), then an edit switches their ping on
    const added = sent.slice(sentBefore);
    assert.ok(added.length > 0);
    for (const m of added) {
      assert.deepEqual(m.sentPayload.allowedMentions, { parse: [] }, 'an added part notifies nobody');
      assert.equal(isSilent(m.sentPayload), false, 'added part is not silent (that would give it its own name header)');
      assert.notEqual(m.payload, m.sentPayload, 'added part was lit up by an edit');
      assert.deepEqual(m.payload.allowedMentions, { parse: ['users', 'everyone'] }, 'added part is gold');
      assert.ok(/↳ Part \d+ of \d+ · @everyone/.test(texts(m.payload)), 'added part carries the small ping tag');
      assert.notEqual(pingLine(m.payload), '@everyone', 'no big ping line on added parts');
    }
    // the PDF moved to the new last part: it arrives with the edit, not with the quiet send
    const last = added.at(-1);
    assert.ok(!last.sentPayload.files?.length, 'quiet send uploads nothing');
    assert.deepEqual(last.payload.files.map((f) => f.name), ['Rules_v2.pdf']);
    assert.equal(last.attachments.size, 1);
    assert.ok(!texts(r.payload).includes('an:repost'), 'no repost offer for a normal announcement');
  });

  let longParts;
  await step('long announcement → reads as one post: every part gold, notified once, never silent', async () => {
    const { payload } = await run('announce long', { type: 'slash', commandName: 'announce', options: { channel: C.news, ping: 'everyone' } });
    const sid = payload.custom_id.split(':')[2];
    const long = 'Brackets, rules and prizes for the new season. '.repeat(120);
    const preview = await run('announce long submit', { type: 'modal', customId: payload.custom_id, fields: { title: 'Season 4', body: long, more: long, footer: '' } });
    assert.ok(texts(preview.payload).includes('in every part (notified once)'), 'preview explains the pings');
    const before = sent.length;
    const eventsBefore = events.length;
    await run('publish long', { type: 'button', customId: `an:pub:${sid}`, fromMessage: true });
    longParts = sent.slice(before);
    assert.ok(longParts.length >= 2, 'should be split into several messages');
    // part 1 · part 2 (quiet) → lit up · part 3 (quiet) → lit up …
    const order = longParts.flatMap((m, i) => (i === 0 ? [['send', m.id]] : [['send', m.id], ['edit', m.id]]));
    assert.deepEqual(events.slice(eventsBefore), order, 'each part is lit up before the next one is posted');
    longParts.forEach((m, i) => {
      // Discord's "silent" flag would make Discord repeat the bot's name above parts 2+ → never used
      assert.equal(isSilent(m.sentPayload), false, `part ${i + 1} is not silent`);
      assert.equal(m.flags.has(MessageFlags.SuppressNotifications), false, `part ${i + 1} flags`);
      if (i === 0) {
        assert.equal(pingLine(m.payload), '@everyone', 'part 1 has the big ping line');
        assert.deepEqual(m.sentPayload.allowedMentions, { parse: ['users', 'everyone'] }, 'part 1 notifies');
        assert.equal(m.payload, m.sentPayload, 'part 1 is never edited');
      } else {
        assert.deepEqual(m.sentPayload.allowedMentions, { parse: ['users'] }, `part ${i + 1} arrives with the ping not switched on`);
        assert.ok(texts(m.sentPayload).includes(`↳ Part ${i + 1} of ${longParts.length} · @everyone`), `part ${i + 1} shows its tag from the start`);
        assert.deepEqual(m.payload.allowedMentions, { parse: ['users', 'everyone'] }, `part ${i + 1} is gold after the edit`);
        assert.equal(m.payload.flags, MessageFlags.IsComponentsV2, `part ${i + 1}: the edit only sets the V2 flag`);
        assert.notEqual(pingLine(m.payload), '@everyone', `part ${i + 1} has no big ping line`);
        assert.equal(texts(m.payload), texts(m.sentPayload), `part ${i + 1} looks the same before and after the edit`);
      }
      validatePayload(`long part ${i + 1}`, m.payload, { ephemeralOk: false });
      validatePayload(`long part ${i + 1} (as sent)`, m.sentPayload, { ephemeralOk: false });
    });
  });

  await step('Edit Announcement when part 1 was deleted without the bot noticing (stale cache)', async () => {
    const [first, second] = longParts;
    first.goneOnDiscord = true; // deleted on Discord, the delete event was missed → still in the bot's cache
    const { payload } = await run('edit stale ctx', { type: 'context', commandName: 'Edit Announcement', targetMessage: second });
    assert.equal(payload.custom_id, `an:editpost:${first.id}`);
    const r = await run('edit stale submit', { type: 'modal', customId: payload.custom_id, fields: { title: 'Season 4 (updated)', body: 'Now short.', footer: '' } });
    assert.ok(texts(r.payload).includes('first message had been deleted'), 'tells the user what happened');
    assert.equal(g().announcements[first.id], undefined, 'old key dropped');
    assert.deepEqual(g().announcements[second.id]?.messageIds, [second.id], 'announcement continues from part 2');
    assert.ok(texts(second.payload).includes('Season 4 (updated)'), 'remaining message shows the new title');
    assert.equal(pingLine(second.payload), '@everyone');
    assert.ok(longParts.slice(2).every((m) => m.deleted), 'leftover parts removed');
  });

  await step('deleting part 1 keeps the rest editable; deleting all forgets it', async () => {
    const { payload } = await run('announce long 2', { type: 'slash', commandName: 'announce', options: { channel: C.news, ping: R.valorant.id } });
    const sid = payload.custom_id.split(':')[2];
    const long = 'Scrim schedule and check-in rules for every team. '.repeat(120);
    await run('announce long 2 submit', { type: 'modal', customId: payload.custom_id, fields: { body: long, more: long } });
    const before = sent.length;
    await run('publish long 2', { type: 'button', customId: `an:pub:${sid}`, fromMessage: true });
    const parts = sent.slice(before);
    assert.ok(parts.length >= 2);
    for (const m of parts) assert.deepEqual(m.payload.allowedMentions, { parse: ['users'], roles: [R.valorant.id] });
    announcements.onMessageDelete(GUILD_ID, parts[0].id);
    assert.equal(g().announcements[parts[0].id], undefined);
    assert.deepEqual(g().announcements[parts[1].id]?.messageIds, parts.slice(1).map((m) => m.id));
    const ctx = await run('edit after delete ctx', { type: 'context', commandName: 'Edit Announcement', targetMessage: parts[1] });
    assert.equal(ctx.payload.custom_id, `an:editpost:${parts[1].id}`);
    for (const m of parts.slice(1)) announcements.onMessageDelete(GUILD_ID, m.id);
    assert.ok(!Object.values(g().announcements).some((rec) => rec.messageIds.includes(parts[1].id)), 'record removed');
  });

  await step('Edit Announcement when every part is gone → friendly message', async () => {
    const { payload } = await run('announce gone', { type: 'slash', commandName: 'announce', options: { channel: C.news } });
    const sid = payload.custom_id.split(':')[2];
    await run('announce gone submit', { type: 'modal', customId: payload.custom_id, fields: { body: 'Short one.' } });
    await run('publish gone', { type: 'button', customId: `an:pub:${sid}`, fromMessage: true });
    const msg = sent.at(-1);
    const ctx = await run('edit gone ctx', { type: 'context', commandName: 'Edit Announcement', targetMessage: msg });
    msg.goneOnDiscord = true;
    const r = await run('edit gone submit', { type: 'modal', customId: ctx.payload.custom_id, fields: { body: 'Edited' } }, { expectError: true });
    assert.ok(texts(r.payload).includes('Announcement deleted'));
    assert.equal(g().announcements[msg.id], undefined);
  });

  await step('long announcement with files at the bottom → the files arrive with the edit', async () => {
    const { payload } = await run('announce files', { type: 'slash', commandName: 'announce', options: { channel: C.news, ping: R.valorant.id, images: 'bottom', style: 'plain' } });
    const sid = payload.custom_id.split(':')[2];
    const long = 'Map pool, check-in times and prize rules for every division. '.repeat(110);
    await run('announce files submit', {
      type: 'modal',
      customId: payload.custom_id,
      fields: { title: 'Rules', body: long, more: long, footer: '', files: [att('bracket.png'), att('Rules.pdf', 'application/pdf')] },
    });
    const before = sent.length;
    await run('publish files', { type: 'button', customId: `an:pub:${sid}`, fromMessage: true });
    const parts = sent.slice(before);
    const last = parts.at(-1);
    assert.ok(parts.length >= 2);
    assert.ok(parts.every((m) => !m.sentPayload.files?.length), 'nothing is uploaded with a quiet send');
    assert.ok(!/"type":(12|13)[,}]/.test(texts(last.sentPayload)), 'the quiet send shows no file blocks');
    assert.deepEqual(last.payload.files.map((f) => f.name).sort(), ['Rules.pdf', 'bracket.png'], 'the edit uploads both files');
    assert.deepEqual(last.payload.attachments, [], 'the edit sets the attachments (no leftovers)');
    assert.equal(last.attachments.size, 2, 'the last part ends up with both files');
    for (const m of parts) assert.deepEqual(m.payload.allowedMentions, { parse: ['users'], roles: [R.valorant.id] });
    assert.equal(g().announcements[parts[0].id].files.length, 2);
  });

  await step('a part that can’t be lit up → the whole announcement is rolled back', async () => {
    const { payload } = await run('announce fail', { type: 'slash', commandName: 'announce', options: { channel: C.news, ping: 'here' } });
    const sid = payload.custom_id.split(':')[2];
    const long = 'Tournament format and tie-break rules explained in detail. '.repeat(110);
    await run('announce fail submit', { type: 'modal', customId: payload.custom_id, fields: { body: long, more: long } });
    const realSend = C.news.send;
    C.news.send = async (p) => {
      const m = await realSend(p);
      if (p.allowedMentions?.parse?.length === 1) m.edit = async () => Promise.reject(Object.assign(new Error('Missing Access'), { code: 50001, status: 403 }));
      return m;
    };
    const before = sent.length;
    const recs = Object.keys(g().announcements).length;
    const i = interaction({ type: 'button', customId: `an:pub:${sid}`, fromMessage: true });
    try {
      await handleInteraction(i);
    } finally {
      C.news.send = realSend;
    }
    assert.equal(unexpected.length, 1, 'the failure is logged once');
    unexpected.length = 0;
    const [, reply] = i.log.at(-1);
    assert.ok(texts(reply).includes('View Channel'), 'tells the admin what went wrong');
    const posted = sent.slice(before);
    assert.ok(posted.length >= 2, 'part 1 and part 2 were posted');
    assert.ok(posted.every((m) => m.deleted), 'no half announcement is left behind');
    assert.equal(Object.keys(g().announcements).length, recs, 'nothing recorded');
  });

  await step('announcement from an older version (silent parts) → Edit offers 🔁 Repost → one clean post, nobody pinged', async () => {
    const { payload } = await run('announce legacy', { type: 'slash', commandName: 'announce', options: { channel: C.news, ping: 'everyone' } });
    const sid = payload.custom_id.split(':')[2];
    const long = 'Code of conduct, reporting and appeals for every member. '.repeat(120);
    await run('announce legacy submit', {
      type: 'modal',
      customId: payload.custom_id,
      fields: { title: 'Server Rules', body: long, more: long, footer: '— Staff', files: [att('rules.png'), att('Rules.pdf', 'application/pdf')] },
    });
    let before = sent.length;
    await run('publish legacy', { type: 'button', customId: `an:pub:${sid}`, fromMessage: true });
    const old = sent.slice(before);
    assert.ok(old.length >= 2);
    // what the older bot did: parts 2+ were sent with Discord's silent flag (can't be removed afterwards)
    for (const m of old.slice(1)) m.flags = new MessageFlagsBitField(MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications);

    const ctx = await run('legacy edit ctx', { type: 'context', commandName: 'Edit Announcement', targetMessage: old[1] });
    const r = await run('legacy edit submit', { type: 'modal', customId: ctx.payload.custom_id, fields: { title: 'Server Rules', body: long, more: long, footer: '— Staff' } });
    const repostId = `an:repost:${old[0].id}:${admin.id}`;
    assert.ok(texts(r.payload).includes(repostId), 'offers the Repost button');
    assert.ok(texts(r.payload).includes('silent'), 'explains why the name shows up again');

    await run('repost by someone else', { type: 'button', customId: repostId, member: staff, fromMessage: true }, { expectError: true });
    assert.ok(old.every((m) => !m.deleted), 'someone else can’t use it');

    before = sent.length;
    const done = await run('repost', { type: 'button', customId: repostId, fromMessage: true });
    assert.ok(texts(done.payload).includes('Announcement reposted'));
    const fresh = sent.slice(before);
    assert.equal(fresh.length, old.length, 'same parts');
    assert.ok(old.every((m) => m.deleted), 'old copy removed');
    fresh.forEach((m, i) => {
      assert.deepEqual(m.sentPayload.allowedMentions, { parse: [] }, `part ${i + 1} notifies nobody`);
      assert.equal(isSilent(m.sentPayload), false, `part ${i + 1} is not silent`);
      assert.deepEqual(m.payload.allowedMentions, { parse: ['users', 'everyone'] }, `part ${i + 1} is gold`);
      validatePayload(`repost part ${i + 1}`, m.payload, { ephemeralOk: false });
    });
    assert.equal(pingLine(fresh[0].payload), '@everyone', 'part 1 keeps the big ping line');
    assert.ok(texts(fresh.at(-1).payload).includes('— Staff'), 'same content');
    const rec = g().announcements[fresh[0].id];
    assert.deepEqual(rec?.messageIds, fresh.map((m) => m.id), 'the record follows the new messages');
    assert.equal(g().announcements[old[0].id], undefined, 'old record gone');
    assert.equal(rec.files.length, 2, 'files carried over');
    assert.equal(fresh.reduce((n, m) => n + m.attachments.size, 0), 2, 'both files re-uploaded');
    for (const m of old) announcements.onMessageDelete(GUILD_ID, m.id); // the old messages' delete events
    assert.deepEqual(g().announcements[fresh[0].id]?.messageIds, fresh.map((m) => m.id), 'delete events of the old copy change nothing');
    await run('repost again', { type: 'button', customId: repostId, fromMessage: true }, { expectError: true });
  });

  await step('Discord 503 while opening a form → one calm warning, no error', async () => {
    const warnings = [];
    const realWarn = log.warn;
    log.warn = (...a) => warnings.push(a.join(' '));
    try {
      const i = interaction({ type: 'slash', commandName: 'announce', options: { channel: C.news } });
      i.showModal = async () => {
        throw Object.assign(new Error('Service Unavailable'), { name: 'HTTPError', status: 503 });
      };
      i.reply = async () => {
        throw Object.assign(new Error('Unknown interaction'), { code: 10062 });
      };
      await handleInteraction(i);
    } finally {
      log.warn = realWarn;
    }
    assert.equal(unexpected.length, 0, `no errors expected: ${unexpected.join(' | ')}`);
    assert.ok(warnings.some((w) => w.includes('temporary problem') && w.includes('503')), warnings.join(' | '));
    assert.ok(warnings.some((w) => w.includes('already expired')), warnings.join(' | '));
  });

  await step('Post as Announcement (draft with files) → publish', async () => {
    const draft = mockMessage(C.roles, { files: [{ name: 'bracket.png' }] }, { content: 'Bracket for **tonight** is up!', author: { id: admin.id } });
    const { payload } = await run('post ctx', { type: 'context', commandName: 'Post as Announcement', targetMessage: draft });
    const sid = payload.custom_id.split(':')[2];
    const preview = await run('post ctx submit', { type: 'modal', customId: payload.custom_id, fields: { title: 'Tonight', body: draft.content, channel: C.news, ping: [R.valorant.id], footer: '' } });
    assert.equal(preview.payload.files.length, 1);
    await run('publish draft', { type: 'button', customId: `an:pub:${sid}`, fromMessage: true });
    assert.deepEqual(sent.at(-1).payload.allowedMentions, { parse: ['users'], roles: [R.valorant.id] });
  });

  await step('files too large to preview → preview without files, publish still uploads', async () => {
    const { payload } = await run('announce big', { type: 'slash', commandName: 'announce', options: { channel: C.news } });
    const sid = payload.custom_id.split(':')[2];
    const i = interaction({ type: 'modal', customId: payload.custom_id, fields: { body: 'Big files', files: [att('huge.png')] } });
    const realEdit = i.editReply;
    let first = true;
    i.editReply = async (p) => {
      if (first && p.files?.length) {
        first = false;
        throw Object.assign(new Error('Request entity too large'), { code: 40005 });
      }
      return realEdit(p);
    };
    await handleInteraction(i);
    if (unexpected.length) throw new Error(unexpected.join('\n'));
    const [, shown] = i.log.at(-1);
    assert.equal(shown.files.length, 0);
    assert.ok(texts(shown).includes('Too large to preview'));
    const before = sent.length;
    await run('publish big', { type: 'button', customId: `an:pub:${sid}`, fromMessage: true });
    assert.equal(sent.length, before + 1);
    assert.equal(sent.at(-1).payload.files.length, 1);
  });

  await step('empty announcement is rejected with a friendly message', async () => {
    const { payload } = await run('announce empty', { type: 'slash', commandName: 'announce', options: { channel: C.news } });
    await run('announce empty submit', { type: 'modal', customId: payload.custom_id, fields: {} }, { expectError: true });
  });

  await step('Discard + expired draft + ping autocomplete', async () => {
    const { payload } = await run('announce 2', { type: 'slash', commandName: 'announce', options: { channel: C.news } });
    const sid = payload.custom_id.split(':')[2];
    await run('announce 2 submit', { type: 'modal', customId: payload.custom_id, fields: { body: 'hello' } });
    await run('discard', { type: 'button', customId: `an:x:${sid}`, fromMessage: true });
    const r = await run('expired', { type: 'button', customId: `an:pub:${sid}`, fromMessage: true });
    assert.ok(texts(r.payload).includes('expired'));
    const ac = await run('ping ac', { type: 'autocomplete', commandName: 'announce', options: { focused: 'ping', ping: 'val' } });
    assert.equal(ac.payload[0].value, R.valorant.id);
  });

  console.log('Welcome');
  await step('/welcome setup → preview with banner', async () => {
    const r = await run('welcome setup', { type: 'slash', commandName: 'welcome', sub: 'setup', options: { channel: C.welcome, image: true, color: 'violet' } });
    assert.equal(r.payload.files.length, 1);
    assert.equal(g().welcome.enabled, true);
  });
  await step('/welcome message form, image background, buttons, autorole', async () => {
    const { payload } = await run('welcome message', { type: 'slash', commandName: 'welcome', sub: 'message' });
    assert.equal(payload.custom_id, 'wl:msg');
    await run('welcome message submit', { type: 'modal', customId: 'wl:msg', fields: { title: 'Welcome {name}!', message: 'Hey {user}, you are our {members_ordinal} member.', subtitle: 'Let the games begin' } });
    await run('welcome image', { type: 'slash', commandName: 'welcome', sub: 'image', options: { enabled: true, background: att('bg.png') } });
    assert.ok(g().welcome.background?.length > 100);
    await run('welcome buttons', { type: 'slash', commandName: 'welcome', sub: 'buttons', options: { rules_channel: C.other, roles_channel: C.roles } });
    await run('welcome autorole', { type: 'slash', commandName: 'welcome', sub: 'autorole', options: { role: R.member } });
    await run('welcome autorole admin', { type: 'slash', commandName: 'welcome', sub: 'autorole', options: { role: R.admin } }, { expectError: true });
  });
  await step('/welcome image off, toggle, test, settings', async () => {
    const r = await run('image off', { type: 'slash', commandName: 'welcome', sub: 'image', options: { enabled: false } });
    assert.equal(r.payload.files.length, 0);
    await run('image on', { type: 'slash', commandName: 'welcome', sub: 'image', options: { enabled: true } });
    await run('toggle off', { type: 'slash', commandName: 'welcome', sub: 'toggle', options: { enabled: false } });
    await run('toggle on', { type: 'slash', commandName: 'welcome', sub: 'toggle', options: { enabled: true } });
    await run('test private', { type: 'slash', commandName: 'welcome', sub: 'test' });
    await run('test public', { type: 'slash', commandName: 'welcome', sub: 'test', options: { public: true } });
    await run('settings', { type: 'slash', commandName: 'welcome', sub: 'settings' });
  });
  await step('new member joins → auto-role + welcome posted with ping', async () => {
    const newbie = mockMember('700000000000000003', [], 0);
    const before = sent.length;
    await welcome.onMemberAdd(newbie);
    assert.ok(newbie.have.has(R.member.id));
    assert.equal(sent.length, before + 1);
    const msg = sent.at(-1);
    assert.equal(msg.channel, C.welcome);
    assert.deepEqual(msg.payload.allowedMentions, { users: [newbie.id] });
    assert.ok(JSON.stringify(msg.payload.components.map(toJSON)).includes('you are our 1,284th member'));
    validatePayload('welcome message', msg.payload, { ephemeralOk: false });
    const bot = mockMember('700000000000000004');
    bot.user.bot = true;
    await welcome.onMemberAdd(bot);
    assert.equal(sent.length, before + 1, 'bots are not welcomed');
  });

  console.log('Server IDs');
  await step('/ids → private map of every channel & role with IDs + .txt file; page buttons update in place', async () => {
    const r = await run('ids', { type: 'slash', commandName: 'ids' });
    assert.equal(r.kind, 'reply');
    assert.ok(r.payload.flags & MessageFlags.Ephemeral, 'only the admin sees it');
    assert.ok(texts(r.payload).includes('```'), 'list is in a code block');
    const file = r.payload.files[0];
    assert.ok(file.name.endsWith('-ids.txt'));
    const txt = file.attachment.toString('utf8');
    for (const ch of guild.channels.cache.values()) assert.ok(txt.includes(`${ch.name}`) && txt.includes(ch.id), `file lists #${ch.name}`);
    for (const role of roles.values()) assert.ok(txt.includes(role.id), `file lists ${role.name}`);
    assert.ok(txt.includes(`📢 ${C.news.name} — ${C.news.id}`), 'announcement channel icon');
    assert.ok(texts(r.payload).includes(`attachment://${file.name}`), 'file card references the upload');
    const u = await run('ids page', { type: 'button', customId: 'ids:go:7:next', fromMessage: true });
    assert.equal(u.kind, 'update');
    assert.deepEqual(u.payload.attachments, [], 'old file replaced, not duplicated');
    assert.equal(u.payload.files.length, 1);
  });

  console.log('Help');
  await step('/help', async () => {
    await run('help', { type: 'slash', commandName: 'help' });
  });

  console.log('Auto reactions');
  const EMO = {
    hype: { id: '320000000000000001', name: 'hype', animated: false },
    gg: { id: '320000000000000002', name: 'gg', animated: false },
    party: { id: '320000000000000003', name: 'party', animated: true },
  };
  for (const e of Object.values(EMO)) guild.emojis.cache.set(e.id, { ...e, available: true, roles: { cache: new Collection() } });
  guild.emojis.cache.set('320000000000000004', { id: '320000000000000004', name: 'vip', animated: false, available: true, roles: { cache: new Collection([[R.high.id, R.high]]) } });
  const tag = (e) => `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`;
  const chat = mockChannel('200000000000000005', 'chat');
  const someone = { id: '700000000000000010', bot: false };
  const otherBot = { id: '700000000000000011', bot: true };
  /** A new message from someone else, the way Discord delivers it. */
  const incoming = (channel, extra = {}) => {
    const m = mockMessage(channel, { content: 'hello' }, { author: someone, type: MessageType.Default, ...extra });
    channel._messages.set(m.id, m);
    return m;
  };
  const reactedWith = (m) => m.reacted ?? [];
  const autoreact = (name, sub, options, opts) => run(name, { type: 'slash', commandName: 'autoreact', sub, options }, opts);

  await step('/autoreact set → every new message gets the emojis, in order (members, bots, webhooks, joins)', async () => {
    const r = await autoreact('autoreact set', 'set', { channel: chat, emojis: `${tag(EMO.hype)} :gg: 🔥 🔥` });
    assert.ok(texts(r.payload).includes('Auto reactions on'));
    assert.ok(texts(r.payload).includes(`${tag(EMO.hype)} ${tag(EMO.gg)} 🔥`), 'shows the list');
    assert.deepEqual(g().autoReact[chat.id].emojis.map((e) => e.id ?? e.name), [EMO.hype.id, EMO.gg.id, '🔥']);
    assert.equal(g().autoReact[chat.id].bots, true, 'bots too by default');
    const expected = [tag(EMO.hype), tag(EMO.gg), '🔥'];
    const kinds = [
      incoming(chat),
      incoming(chat, { author: otherBot }),
      incoming(chat, { author: otherBot, webhookId: '900000000000000001' }),
      incoming(chat, { type: MessageType.UserJoin }),
      incoming(chat, { type: MessageType.Reply }),
      incoming(chat, { author: otherBot, type: MessageType.ChatInputCommand }),
    ];
    for (const m of kinds) {
      await autoReact.onMessage(m);
      assert.deepEqual(reactedWith(m), expected);
    }
    const pin = incoming(chat, { type: MessageType.ChannelPinnedMessage });
    const mine = mockMessage(chat, { content: 'posted by the bot itself' });
    const elsewhere = incoming(C.other);
    for (const m of [pin, mine, elsewhere]) await autoReact.onMessage(m);
    await autoReact.idle();
    assert.deepEqual([pin, mine, elsewhere].map(reactedWith), [[], [], []], 'pin notices, my own posts (handled separately) and other channels are skipped');
  });

  await step('bots:false → only members’ messages get reactions', async () => {
    await autoreact('autoreact bots off', 'set', { channel: chat, emojis: '🔥', bots: false });
    const human = incoming(chat);
    const robot = incoming(chat, { author: otherBot });
    const hook = incoming(chat, { author: { id: '700000000000000013' }, webhookId: '900000000000000002' });
    for (const m of [human, robot, hook]) await autoReact.onMessage(m);
    await autoReact.idle();
    assert.deepEqual([human, robot, hook].map(reactedWith), [['🔥'], [], []]);
    await autoreact('autoreact bots on', 'set', { channel: chat, emojis: ':hype: :gg:', bots: true });
  });

  await step('/autoreact add · list · remove (autocomplete) · turn off', async () => {
    let r = await autoreact('autoreact add', 'add', { channel: chat, emojis: ':party: :gg:' });
    assert.ok(texts(r.payload).includes('Emojis added') && texts(r.payload).includes('1 of them were already on the list'));
    assert.deepEqual(g().autoReact[chat.id].emojis.map((e) => e.name), ['hype', 'gg', 'party']);
    r = await autoreact('autoreact add again', 'add', { channel: chat, emojis: ':gg:' });
    assert.ok(texts(r.payload).includes('Already on the list'));
    r = await autoreact('autoreact list', 'list', {});
    assert.ok(texts(r.payload).includes(`<#${chat.id}>`) && texts(r.payload).includes(tag(EMO.party)) && texts(r.payload).includes('🤖 bots too'));
    const ac = await run('autoreact ac', { type: 'autocomplete', commandName: 'autoreact', options: { focused: 'emoji', emoji: 'par', channel: chat } });
    assert.deepEqual(ac.payload, [{ name: ':party: (animated)', value: EMO.party.id }]);
    r = await autoreact('autoreact remove one', 'remove', { channel: chat, emoji: EMO.party.id });
    assert.ok(texts(r.payload).includes('Emoji removed'));
    await autoreact('autoreact remove typed', 'remove', { channel: chat, emoji: ':GG:' });
    assert.deepEqual(g().autoReact[chat.id].emojis.map((e) => e.name), ['hype']);
    await autoreact('autoreact remove missing', 'remove', { channel: chat, emoji: '🍕' }, { expectError: true });
    r = await autoreact('autoreact off', 'remove', { channel: chat });
    assert.ok(texts(r.payload).includes('Auto reactions off'));
    assert.equal(g().autoReact[chat.id], undefined);
    const after = incoming(chat);
    await autoReact.onMessage(after);
    assert.deepEqual(reactedWith(after), [], 'nothing once it’s off');
    r = await autoreact('autoreact list empty', 'list', {});
    assert.ok(texts(r.payload).includes('No auto reactions yet'));
  });

  await step('emojis that can’t be used → clear error, nothing saved', async () => {
    let r = await autoreact('bad names', 'set', { channel: chat, emojis: ':nope: 🔥 <:foreign:399999999999999999>' }, { expectError: true });
    assert.ok(texts(r.payload).includes('no emoji called `:nope:`') && texts(r.payload).includes('from a server I’m not in'));
    r = await autoreact('role-limited', 'set', { channel: chat, emojis: ':vip:' }, { expectError: true });
    assert.ok(texts(r.payload).includes('limited to certain roles'));
    r = await autoreact('too many', 'set', { channel: chat, emojis: '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋' }, { expectError: true });
    assert.ok(texts(r.payload).includes('at most 20'));
    const realPerms = chat.permissionsFor;
    chat.permissionsFor = () => ({ has: (flag) => flag !== PermissionFlagsBits.AddReactions });
    try {
      r = await autoreact('no permission', 'set', { channel: chat, emojis: '🔥' }, { expectError: true });
      assert.ok(texts(r.payload).includes('Add Reactions'));
    } finally {
      chat.permissionsFor = realPerms;
    }
    assert.equal(g().autoReact[chat.id], undefined, 'nothing was saved');
  });

  await step('announcement in an auto-react channel → reactions only on its last part', async () => {
    await autoreact('autoreact news', 'set', { channel: C.news, emojis: ':gg: 🔥' });
    const { payload } = await run('announce ar', { type: 'slash', commandName: 'announce', options: { channel: C.news, ping: 'everyone' } });
    const sid = payload.custom_id.split(':')[2];
    const long = 'Registration, check-in and prize details for the new season. '.repeat(110);
    await run('announce ar submit', { type: 'modal', customId: payload.custom_id, fields: { title: 'Season 5', body: long, more: long } });
    const before = sent.length;
    await run('publish ar', { type: 'button', customId: `an:pub:${sid}`, fromMessage: true });
    const parts = sent.slice(before);
    for (const m of parts) await autoReact.onMessage(m); // Discord delivers the bot's own messages too: no double reactions
    await autoReact.idle();
    assert.ok(parts.length >= 2);
    assert.ok(parts.slice(0, -1).every((m) => !reactedWith(m).length), 'no reactions between the parts');
    assert.deepEqual(reactedWith(parts.at(-1)), [tag(EMO.gg), '🔥'], 'reactions at the end of the whole post');
    await autoreact('autoreact news off', 'remove', { channel: C.news });
  });

  await step('welcome messages get the welcome channel’s reactions', async () => {
    await autoreact('autoreact welcome', 'set', { channel: C.welcome, emojis: '👋 :hype:' });
    const newbie = mockMember('700000000000000012', [], 0);
    const before = sent.length;
    await welcome.onMemberAdd(newbie);
    await autoReact.idle();
    assert.equal(sent.length, before + 1);
    assert.deepEqual(reactedWith(sent.at(-1)), ['👋', tag(EMO.hype)]);
  });

  await step('emoji deleted from the server → taken off every list', async () => {
    await autoreact('autoreact chat gg', 'set', { channel: chat, emojis: ':gg:' });
    // Discord answers "Unknown Emoji" while reacting (deleted, and the delete event was missed)
    const m = incoming(C.welcome);
    const realReact = m.react;
    m.react = async (e) => {
      if (String(e).includes(EMO.hype.id)) throw Object.assign(new Error('Unknown Emoji'), { code: 10014, status: 400 });
      return realReact(e);
    };
    await autoReact.onMessage(m);
    assert.deepEqual(reactedWith(m), ['👋'], 'the other emojis still go on');
    assert.deepEqual(g().autoReact[C.welcome.id].emojis.map((e) => e.name), ['👋'], ':hype: dropped from the list');
    autoReact.onEmojiDelete({ id: EMO.gg.id, name: 'gg', guild }); // the normal delete event
    assert.equal(g().autoReact[chat.id], undefined, 'a list left empty is switched off');
  });

  await step('missing permission while reacting → one warning, no crash', async () => {
    const warnings = [];
    const realWarn = log.warn;
    log.warn = (...a) => warnings.push(a.join(' '));
    try {
      for (let k = 0; k < 3; k++) {
        const m = incoming(C.welcome);
        m.react = async () => Promise.reject(Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 }));
        await autoReact.onMessage(m);
      }
    } finally {
      log.warn = realWarn;
    }
    assert.equal(warnings.length, 1, warnings.join('\n'));
    assert.match(warnings[0], /can’t react in #welcome.*Add Reactions/);
  });

  await step('forum channel → the first message of every new post', async () => {
    const forum = mockChannel('200000000000000006', 'suggestions', ChannelType.GuildForum);
    const r = await autoreact('autoreact forum', 'set', { channel: forum, emojis: '👍 👎' });
    assert.ok(texts(r.payload).includes('every new post gets'));
    const post = mockChannel('200000000000000007', 'Add a 2v2 bracket', ChannelType.PublicThread);
    post.parentId = forum.id;
    const starter = incoming(post, { id: post.id });
    const reply = incoming(post);
    for (const m of [starter, reply]) await autoReact.onMessage(m);
    await autoReact.idle();
    assert.deepEqual(reactedWith(starter), ['👍', '👎']);
    assert.deepEqual(reactedWith(reply), [], 'replies inside a post are left alone');
  });

  await step('busy channel → backlog capped with one warning, everything queued still gets its reactions', async () => {
    const busy = mockChannel('200000000000000008', 'spam');
    await autoreact('autoreact busy', 'set', { channel: busy, emojis: '🔥' });
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    const warnings = [];
    const realWarn = log.warn;
    log.warn = (...a) => warnings.push(a.join(' '));
    const msgs = [];
    let queued = 0;
    try {
      for (let k = 0; k < autoReact.MAX_BACKLOG + 5; k++) {
        const m = incoming(busy);
        const realReact = m.react;
        m.react = async (e) => {
          await gate; // Discord is slow: nothing finishes until the gate opens
          return realReact(e);
        };
        msgs.push(m);
        if (autoReact.onMessage(m)) queued++;
      }
      assert.equal(queued, autoReact.MAX_BACKLOG, 'at most MAX_BACKLOG messages wait per channel');
      assert.equal(warnings.length, 1, 'one warning, not one per message');
      open();
      await autoReact.idle();
    } finally {
      log.warn = realWarn;
    }
    assert.equal(msgs.filter((m) => reactedWith(m).length).length, autoReact.MAX_BACKLOG);
    const later = incoming(busy);
    await autoReact.onMessage(later);
    assert.deepEqual(reactedWith(later), ['🔥'], 'back to normal once caught up');
  });

  await step('channel deleted → its auto reactions are forgotten', async () => {
    assert.ok(g().autoReact['200000000000000006']);
    autoReact.onChannelDelete({ id: '200000000000000006', guild });
    assert.equal(g().autoReact['200000000000000006'], undefined);
  });

  await store.flush();
  server.close();
  console.log(`\n${process.exitCode ? '❌ Some flows failed' : '✅ All flows passed'} (${passed} steps · ${sent.length} messages sent · ${edits.length} edits)`);
  process.exit(process.exitCode ?? 0);
})();
