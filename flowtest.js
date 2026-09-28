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
const { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const { createCanvas } = require('@napi-rs/canvas');
const { validatePayload, toJSON } = require('./helpers/validate');

const store = require('../src/lib/store');
const log = require('../src/lib/log');
const handleInteraction = require('../src/interactions');
const welcome = require('../src/features/welcome');
const reactionRoles = require('../src/features/reactionRoles');

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
    attachments: attachmentsFrom(payload?.files),
    reactions: { cache: new Collection(), removeAll: async () => m.reactions.cache.clear() },
    async edit(p) {
      if (p.attachments && p.attachments.length === 0) m.attachments = attachmentsFrom(p.files);
      m.payload = p;
      edits.push(p);
      return m;
    },
    async delete() {
      channel._messages.delete(id);
      m.deleted = true;
    },
    async react(e) {
      reacts.push(e);
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
      return m;
    },
    messages: {
      fetch: async (mid) => {
        const m = ch._messages.get(mid);
        if (!m) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
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
    await run('edit ctx submit', { type: 'modal', customId: payload.custom_id, fields: { title: 'Season 3 is HERE', body: long, more: long, footer: '' } });
    const rec = g().announcements[announcement.id];
    assert.ok(rec.messageIds.length >= 2, 'long edit should span multiple messages');
    assert.equal(rec.files.length, 2);
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

  console.log('Help');
  await step('/help', async () => {
    await run('help', { type: 'slash', commandName: 'help' });
  });

  await store.flush();
  server.close();
  console.log(`\n${process.exitCode ? '❌ Some flows failed' : '✅ All flows passed'} (${passed} steps · ${sent.length} messages sent · ${edits.length} edits)`);
  process.exit(process.exitCode ?? 0);
})();
