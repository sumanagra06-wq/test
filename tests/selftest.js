'use strict';
/**
 * Offline self-test: builds every message/modal the bot can send with a mock server and
 * checks them against Discord's Components V2 limits. Run with:  npm test
 */
process.env.DISCORD_TOKEN ||= 'selftest';
process.env.DATA_DIR = require('node:path').join(require('node:os').tmpdir(), `ab-selftest-${Date.now()}`);

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ChannelType, Collection, ComponentType, MessageFlags, PermissionFlagsBits, PermissionsBitField } = require('discord.js');

const utils = require('../src/lib/utils');
const ui = require('../src/lib/ui');
const store = require('../src/lib/store');
const buttonRoles = require('../src/features/buttonRoles');
const reactionRoles = require('../src/features/reactionRoles');
const announcements = require('../src/features/announcements');
const welcome = require('../src/features/welcome');
const help = require('../src/features/help');
const serverIds = require('../src/features/serverIds');
const { commands } = require('../src/commands');
const { colorChoices } = require('../src/interactions');

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`✗ ${name}\n`, err);
    process.exitCode = 1;
  }
};
const checkAsync = async (name, fn) => {
  try {
    await fn();
    passed++;
  } catch (err) {
    console.error(`✗ ${name}\n`, err);
    process.exitCode = 1;
  }
};

const { validatePayload } = require('./helpers/validate');

/* ───────────── mock server ───────────── */

const roles = new Collection();
const guild = {
  id: '100000000000000001',
  name: 'AetherBrackets',
  memberCount: 1284,
  ownerId: '100000000000000009',
  iconURL: () => 'https://cdn.discordapp.com/embed/avatars/1.png',
  roles: { cache: roles, everyone: null },
  channels: { cache: new Collection([['200000000000000001', { id: '200000000000000001', name: 'roles', isTextBased: () => true }]]) },
  emojis: { cache: new Collection([['300000000000000001', { id: '300000000000000001', name: 'aether', animated: false }]]) },
  client: { user: { id: '100000000000000002' } },
};
for (let i = 0; i < 30; i++) {
  const id = String(400000000000000000n + BigInt(i));
  roles.set(id, { id, name: `Game Role ${i + 1} ${'x'.repeat(i % 3 === 0 ? 40 : 0)}`, position: 30 - i, managed: false, mentionable: true });
}
const roleIds = [...roles.keys()];
const emojis = ['🎮', '⚽', '🏀', '🎯', '🧩', '🏆', '⚔️', '🛡️', '🚀', '🔥', '❄️', '🌙', '⭐', '🎲', '🎧', '🕹️', '🏎️', '🥇', '🐉', '👑', '💎', '🌈', '⚡', '🌀', '🍀'];

function panel(style, mode, n, extra = {}) {
  return {
    id: 'abc123',
    channelId: '200000000000000001',
    messageId: '500000000000000001',
    title: '🎮 Pick your games',
    description: 'Grab the roles for the games you play to get pinged for **brackets & scrims**.',
    footer: '',
    color: null,
    style,
    mode,
    bannerUrl: null,
    bannerFile: null,
    roles: roleIds.slice(0, n).map((id, i) => ({
      roleId: id,
      label: i === 0 ? 'L'.repeat(80) : `Game ${i + 1}`,
      emoji: i % 4 === 3 ? { id: '300000000000000001', name: 'aether', animated: false } : { id: null, name: emojis[i] },
      description: i % 2 ? 'D'.repeat(100) : null,
      buttonColor: ['grey', 'blue', 'green', 'red'][i % 4],
    })),
    createdBy: '1',
    createdAt: Date.now(),
    ...extra,
  };
}

/* ───────────── tests ───────────── */

(async () => {
  // utils
  check('parseMessageRef', () => {
    assert.deepEqual(utils.parseMessageRef('https://discord.com/channels/1234567890123456/2234567890123456/3234567890123456'), {
      guildId: '1234567890123456',
      channelId: '2234567890123456',
      messageId: '3234567890123456',
    });
    assert.equal(utils.parseMessageRef('https://ptb.discord.com/channels/1234567890123456/2234567890123456/3234567890123456').messageId, '3234567890123456');
    assert.deepEqual(utils.parseMessageRef('2234567890123456-3234567890123456'), { channelId: '2234567890123456', messageId: '3234567890123456' });
    assert.equal(utils.parseMessageRef('3234567890123456').messageId, '3234567890123456');
    assert.equal(utils.parseMessageRef('hello'), null);
  });
  check('parseEmoji + emojiKey', () => {
    assert.deepEqual(utils.parseEmoji('<:gg:123456789012345678>'), { id: '123456789012345678', name: 'gg', animated: false });
    assert.deepEqual(utils.parseEmoji('<a:party:123456789012345678>'), { id: '123456789012345678', name: 'party', animated: true });
    assert.equal(utils.parseEmoji('🎮').name, '🎮');
    assert.equal(utils.parseEmoji('hello'), null);
    assert.equal(utils.parseEmoji(':aether:', guild).id, '300000000000000001');
    assert.equal(utils.emojiKey(utils.parseEmoji('⚔️')), utils.emojiKey({ id: null, name: '⚔' }), 'FE0F variants must match');
    assert.equal(utils.parseEmoji('🇮🇳').name, '🇮🇳');
    assert.equal(utils.parseEmoji('1️⃣').name, '1️⃣');
  });
  check('chunkText keeps code fences balanced', () => {
    const long = `Intro\n\n\`\`\`js\n${'console.log(1);\n'.repeat(400)}\`\`\`\n\nOutro`;
    const chunks = utils.chunkText(long, 1500);
    assert.ok(chunks.length > 3);
    for (const c of chunks) {
      assert.ok(c.length <= 1500, `chunk ${c.length}`);
      assert.equal((c.match(/```/g) || []).length % 2, 0, 'unbalanced fence');
    }
  });
  check('fillTemplate / ordinal / safeFileName', () => {
    assert.equal(utils.fillTemplate('Hi {User} #{members} {unknown}', { user: '<@1>', members: '5' }), 'Hi <@1> #5 {unknown}');
    assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111, 1284].map(utils.ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '111th', '1,284th']);
    const used = new Set();
    assert.equal(utils.safeFileName('My Poster (final).PNG', used), 'My_Poster_final.png');
    assert.equal(utils.safeFileName('My Poster (final).png', used), 'My_Poster_final-2.png');
    assert.equal(utils.safeFileName('ñandú résumé.pdf', used), 'nandu_resume.pdf');
    assert.equal(utils.safeFileName('🔥🔥.jpg', used), 'file.jpg');
  });
  check('commands', () => {
    assert.equal(commands.length, 8);
    const names = commands.map((c) => c.name);
    assert.ok(names.includes('Post as Announcement') && names.includes('announce'));
    const ids = commands.find((c) => c.name === 'ids');
    assert.equal(ids?.default_member_permissions, String(PermissionFlagsBits.ManageGuild), '/ids is for staff');
  });

  // /ids — a big server: pages, headers, sidebar order, every ID, Discord limits
  check('server map (/ids) on a big server', () => {
    const everyoneRole = { id: '900000000000000000', name: '@everyone', position: 0, managed: false, permissions: new PermissionsBitField() };
    let seq = 900000000000000001n;
    const nid = () => String(seq++);
    const chans = new Map();
    const mk = (name, type, parentId = null, rawPosition = 0, priv = false, thread = false) => {
      const c = { id: nid(), name, type, parentId, rawPosition, isThread: () => thread, permissionsFor: () => ({ has: () => !priv }) };
      chans.set(c.id, c);
      return c;
    };
    const loose = [mk('lobby-voice', ChannelType.GuildVoice, null, 0), mk('welcome', ChannelType.GuildText, null, 1), mk('rules', ChannelType.GuildText, null, 0)];
    const cats = [];
    for (let k = 44; k >= 0; k--) cats.push(mk(`Category ${String(k).padStart(2, '0')}`, ChannelType.GuildCategory, null, k, k === 7)); // created in reverse order
    const empty = mk('Archive', ChannelType.GuildCategory, null, 99);
    for (const cat of cats) {
      for (let j = 9; j >= 0; j--) mk(j % 3 ? `chat-${j}` : `Voice ${j}`, j % 3 ? ChannelType.GuildText : ChannelType.GuildVoice, cat.id, j, j === 4);
    }
    const thread = mk('some-thread', ChannelType.PublicThread, cats[0].id, 0, false, true);
    const roleMap = new Map([[everyoneRole.id, everyoneRole]]);
    for (let i = 1; i <= 249; i++) {
      const r = { id: nid(), name: i === 100 ? 'Weird `role` name' : `Role ${i}`, position: i, managed: i === 249, permissions: new PermissionsBitField(i === 248 ? PermissionFlagsBits.Administrator : 0n) };
      roleMap.set(r.id, r);
    }
    const g = { id: everyoneRole.id, name: 'Big *Test* Server', channels: { cache: chans }, roles: { cache: roleMap, everyone: everyoneRole } };

    const { lines, stats } = serverIds.buildMap(g);
    assert.deepEqual(stats, { categories: 46, channels: 453, roles: 250 });
    const { pages, rolesPage } = serverIds.paginate(lines);
    assert.ok(pages.length > 5, 'big server spans several pages');
    const text = lines.map((l) => l.text);
    // sidebar order: loose text channels before loose voice, categories by position, text before voice inside a category
    const idx = (needle) => text.findIndex((t) => t.includes(needle));
    assert.ok(idx('# rules') < idx('# welcome') && idx('# welcome') < idx('🔊 lobby-voice'), 'loose channels in sidebar order');
    assert.ok(idx('📁 Category 00') < idx('📁 Category 01') && idx('📁 Category 44') < idx('📁 Archive'), 'categories by position');
    const c00 = idx('📁 Category 00');
    assert.ok(text[c00 + 1].includes('# chat-1') && text[c00 + 7].includes('🔊 Voice 0'), 'text channels first, then voice');
    assert.ok(text[idx('📁 Archive') + 1].includes('(empty)'));
    assert.ok(text.some((t) => t.startsWith('📁 Category 07 🔒')) && text.some((t) => t.includes('# chat-4 🔒')), 'private markers');
    assert.ok(!text.some((t) => t.includes(thread.id)), 'threads are skipped');
    assert.ok(text.at(-1).startsWith('@everyone — '), '@everyone is last');
    assert.ok(text.some((t) => t.includes('Role 249 🤖')) && text.some((t) => t.includes('Role 248 🛡️')));
    assert.ok(text.some((t) => t.includes('Weird ˋroleˋ name')), 'backticks neutralised');
    assert.ok(pages[rolesPage].some((t) => t.startsWith('ROLES ·')), 'roles button targets the roles page');

    const seen = new Set();
    pages.forEach((pg, p) => {
      const payload = serverIds.render(g, p);
      validatePayload(`ids page ${p + 1}`, payload);
      const json = payload.components.map((c) => c.toJSON());
      const block = json[0].components[1].content;
      assert.ok(block.startsWith('```\n') && block.endsWith('\n```') && block.split('```').length === 3, `page ${p + 1}: one clean code block`);
      if (p > 0 && pg[0].startsWith('├─') === false && pg[0].startsWith('└─') === false) assert.ok(!pg[0].startsWith(' '), `page ${p + 1} starts cleanly`);
      if (pages[p - 1] && /^[├└]/.test(pages[p - 1].at(-1)) && /[├└]/.test(pg[0])) assert.fail(`page ${p + 1} lost its category header`);
      const ids = [];
      const walk = (n) => {
        if (n.custom_id) ids.push(n.custom_id);
        (n.components ?? []).forEach(walk);
      };
      json.forEach(walk);
      assert.equal(new Set(ids).size, ids.length, `page ${p + 1}: custom ids must be unique`);
      for (const t of pg) seen.add(t);
    });
    for (const t of text.filter(Boolean)) assert.ok(seen.has(t), `every line is on some page: ${t}`);
    assert.ok(pages.some((pg) => pg[0].endsWith('(continued)')), 'a page starting mid-category repeats its header');

    const file = serverIds.render(g, 0).files[0];
    const txt = file.attachment.toString('utf8');
    for (const id of [...chans.keys()].filter((id) => id !== thread.id)) assert.ok(txt.includes(id), `file has channel ${id}`);
    for (const id of roleMap.keys()) assert.ok(txt.includes(id), `file has role ${id}`);
    assert.ok(file.name.endsWith('-ids.txt'));
    // out-of-range pages are clamped
    assert.equal(serverIds.render(g, 999).components[0].toJSON().components[1].content, `\`\`\`\n${pages.at(-1).join('\n')}\n\`\`\``);
    assert.equal(serverIds.render(g, Number.NaN).components[0].toJSON().components[1].content, `\`\`\`\n${pages[0].join('\n')}\n\`\`\``);
    validatePayload('ids big', serverIds.render(g, 1));
  });
  check('color autocomplete', () => {
    assert.equal(colorChoices('#abc')[0].value, '#AABBCC');
    assert.ok(colorChoices('').length <= 25);
    assert.ok(colorChoices('gol').some((c) => c.value === 'gold'));
  });

  // button role panels
  const results = [];
  for (const [style, n] of [
    ['list', 0],
    ['list', 1],
    ['list', 9],
    ['list', 10], // falls back to grid
    ['buttons', 20],
    ['buttons', 21], // falls back to dropdown
    ['dropdown', 25],
  ]) {
    for (const mode of ['toggle', 'unique', 'add']) {
      for (const banner of [false, true]) {
        const p = panel(style, mode, n, banner ? { bannerFile: 'banner.png' } : {});
        const payload = buttonRoles.renderPanel(guild, p);
        if (banner) payload.files = [{ name: 'banner.png' }];
        check(`panel ${style}/${mode}/${n}/${banner}`, () => results.push([`panel ${style}×${n} ${mode}${banner ? ' +banner' : ''}`, validatePayload(`panel ${style} ${n}`, payload, { ephemeralOk: false })]));
      }
    }
  }
  check('effective style fallbacks', () => {
    assert.equal(buttonRoles.effectiveStyle(panel('list', 'toggle', 9)), 'list');
    assert.equal(buttonRoles.effectiveStyle(panel('list', 'toggle', 10)), 'buttons');
    assert.equal(buttonRoles.effectiveStyle(panel('list', 'toggle', 21)), 'dropdown');
    assert.equal(buttonRoles.effectiveStyle(panel('buttons', 'toggle', 21)), 'dropdown');
  });
  for (const n of [1, 11, 12, 25]) {
    for (const mode of ['toggle', 'unique', 'add']) {
      const p = panel(n > 11 ? 'dropdown' : 'list', mode, n);
      const have = new Set(roleIds.slice(0, Math.ceil(n / 2)));
      check(`manager ${n}/${mode}`, () =>
        results.push([`my-roles manager ×${n} ${mode}`, validatePayload(`manager ${n}`, buttonRoles.renderManager(guild, p, have, '✅ Added <@&1>\n➖ Removed <@&2>'))]),
      );
    }
  }
  check('result cards', () => {
    const p = panel('list', 'toggle', 3);
    for (const r of [{ added: ['1'] }, { removed: ['1'] }, { added: ['1'], removed: ['2'] }, { locked: '1' }, {}]) validatePayload('result', buttonRoles.resultCard(p, r));
  });

  // reaction role panels
  for (const n of [0, 1, 20]) {
    const cfg = {
      channelId: '200000000000000001',
      mode: 'unique',
      panel: { title: '😀 React for roles', description: 'Pick the games you play.', color: 0xff00ff },
      entries: roleIds.slice(0, n).map((id, i) => ({ key: emojis[i], emoji: { id: null, name: emojis[i] }, roleId: id, description: i % 2 ? 'D'.repeat(100) : null })),
    };
    check(`reaction panel ${n}`, () => results.push([`reaction panel ×${n}`, validatePayload(`reaction ${n}`, reactionRoles.renderPanel(guild, cfg), { ephemeralOk: false })]));
  }

  // announcements
  const fakeFile = (name, kind, size = 1000) => ({ name, kind, buffer: Buffer.alloc(size), size, spoiler: false });
  const mediaFiles = Array.from({ length: 6 }, (_, i) => fakeFile(`shot-${i}.png`, 'image'));
  const docFiles = [fakeFile('rules.pdf', 'file'), fakeFile('bracket.xlsx', 'file'), fakeFile('trailer.mp4', 'video'), fakeFile('a'.repeat(60) + '.zip', 'file')];
  const longText = 'Lorem ipsum dolor sit amet, **consectetur** adipiscing elit. '.repeat(66); // ~4000
  const cases = [
    ['short card', { title: 'Season 3 registrations are OPEN!', body: 'Sign up now in <#1>. Brackets start **Friday**.', ping: 'everyone' }],
    ['short plain', { style: 'plain', title: 'Patch notes', body: 'Small fixes.', footer: '— The team' }],
    ['max text + 10 files', { title: 'T'.repeat(200), body: longText, more: longText, footer: 'F'.repeat(200), ping: roleIds[0], files: [...mediaFiles, ...docFiles] }],
    ['max text bottom images', { title: 'T'.repeat(200), body: longText, more: longText, imagePosition: 'bottom', files: [...mediaFiles] }],
    ['files only doc', { body: 'See attached', files: [fakeFile('doc.pdf', 'file')] }],
    ['10 images', { body: 'Gallery', files: Array.from({ length: 10 }, (_, i) => fakeFile(`g${i}.jpg`, 'image')) }],
    ['code block long', { body: `\`\`\`\n${'x = 1\n'.repeat(900)}\`\`\`` }],
  ];
  for (const [name, fields] of cases) {
    const a = announcements.newSession({ id: '600000000000000001', channelId: '200000000000000001', ...fields, files: fields.files ?? [] });
    check(`announcement ${name}`, () => {
      const parts = announcements.renderAnnouncement(a);
      const allFiles = new Set();
      parts.forEach((p, i) => {
        validatePayload(`${name} part ${i + 1}`, p, { ephemeralOk: false });
        for (const f of p.files) allFiles.add(f.name);
      });
      assert.equal(allFiles.size, a.files.length, 'every file must be posted exactly once');
      const preview = announcements.renderPreview(guild, a);
      const v = validatePayload(`${name} preview`, preview);
      results.push([`announcement: ${name} (${parts.length} msg)`, v]);
      if (fields.ping === 'everyone') assert.deepEqual(parts[0].allowedMentions, { parse: ['users', 'everyone'] });
      parts.forEach((p, i) => {
        // every part pings the same way; parts 2+ are silent (one notification per announcement)
        if (fields.ping) {
          assert.match(JSON.stringify(p.components), /@everyone|<@&\d+>/, `${name}: part ${i + 1} must carry the ping`);
          if (i > 0) assert.match(JSON.stringify(p.components), /↳ Part \d+ of \d+ · (@everyone|<@&\d+>)/, `${name}: part ${i + 1} small ping tag`);
        }
        assert.deepEqual(p.allowedMentions, parts[0].allowedMentions, `${name}: part ${i + 1} mentions differ`);
        assert.equal(Boolean(p.flags & MessageFlags.SuppressNotifications), i > 0, `${name}: only parts 2+ are silent`);
      });
      assert.deepEqual(preview.allowedMentions, { parse: [] }, 'previews must never ping');
    });
  }

  // all three extra-ping styles stay within Discord's limits
  for (const style of ['tag', 'hidden', 'full']) {
    for (const [name, fields] of cases.filter(([, f]) => f.ping || f.body?.length > 3000)) {
      const a = announcements.newSession({ id: '600000000000000002', channelId: '200000000000000001', ...fields, ping: fields.ping ?? 'here', files: fields.files ?? [] });
      check(`extra ping "${style}" · ${name}`, () => {
        const parts = announcements.renderAnnouncement(a, { extraPing: style });
        parts.forEach((p, i) => validatePayload(`${style} ${name} part ${i + 1}`, p, { ephemeralOk: false }));
      });
    }
  }

  // help + notices
  check('help card', () => results.push(['help card', validatePayload('help', help.helpCard(guild, { displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' }))]));
  check('notice', () => validatePayload('notice', ui.notice('error', 'Oops', 'Something')));

  // welcome (real render incl. banner)
  const member = {
    id: '700000000000000001',
    guild,
    displayName: 'NovaStrike',
    user: { username: 'novastrike', bot: false },
    joinedTimestamp: Date.now(),
    displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/2.png',
  };
  const wcfg = { ...store.defaults.defaultGuild().welcome, enabled: true, channelId: '1', rulesChannelId: '2', rolesChannelId: '3' };
  await checkAsync('welcome image', async () => {
    const p = await welcome.buildWelcomePayload(member, wcfg);
    results.push(['welcome (image)', validatePayload('welcome image', p, { ephemeralOk: false })]);
    assert.equal(p.files.length, 1);
    assert.deepEqual(p.allowedMentions, { users: [member.id] });
  });
  await checkAsync('welcome text', async () => {
    const p = await welcome.buildWelcomePayload(member, { ...wcfg, image: false }, { preview: true });
    results.push(['welcome (text card)', validatePayload('welcome text', p)]);
    assert.equal(p.files.length, 0);
    assert.deepEqual(p.allowedMentions, { parse: [] });
  });

  // store round-trip
  await checkAsync('store JSON round-trip', async () => {
    await store.init();
    const g = store.guild('42');
    g.welcome.enabled = true;
    g.buttonPanels.x = panel('list', 'toggle', 2);
    store.save('42');
    await store.flush();
    const raw = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'aetherbrackets-db.json'), 'utf8'));
    assert.equal(raw.guilds['42'].welcome.enabled, true);
    assert.equal(raw.guilds['42'].buttonPanels.x.roles.length, 2);
  });

  console.log('\nLayout budget (components / 40 · text chars / 4000):');
  const width = Math.max(...results.map(([n]) => n.length));
  const seen = new Set();
  for (const [n, v] of results) {
    if (seen.has(n)) continue;
    seen.add(n);
    console.log(`  ${n.padEnd(width)}  ${String(v.count).padStart(2)} · ${String(v.text).padStart(4)}`);
  }
  console.log(`\n${process.exitCode ? '❌ Some checks failed' : '✅ All checks passed'} (${passed} passed)`);
  process.exit(process.exitCode ?? 0);
})();
