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
const autoReact = require('../src/features/autoReact');
const reactPicker = require('../src/features/reactPicker');
const reactTemplates = require('../src/features/reactTemplates');
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
  check('chunkText starts the next part at a heading', () => {
    const para = (k, j) => `Rule ${k}.${j}: members must follow this at all times, in every channel and voice room.`;
    const section = (k) => [`## ${k}️⃣ Section ${k}`, ...[1, 2, 3, 4, 5].map((j) => para(k, j))].join('\n\n');
    const rules = Array.from({ length: 8 }, (_, k) => section(k + 1)).join('\n\n');
    const chunks = utils.chunkText(rules, 3000);
    assert.equal(chunks.length, 2);
    assert.match(chunks[1], /^## \d️⃣ Section \d$/m, 'part 2 starts with a section heading');
    assert.ok(/^## /.test(chunks[1]), `part 2 should begin at the heading, got: ${chunks[1].slice(0, 40)}`);
  });
  check('chunkText keeps an intro line ending with ":" together with its list', () => {
    for (const intro of ['The following are prohibited:', '**The following are prohibited:**']) {
      const doc = [
        'Members are expected to treat each other with respect and follow the Terms of Service. '.repeat(21).trim(),
        'Report the issue through support with enough information for the team to investigate.',
        intro,
        ['• Self-bots or unauthorized automation.', '• Automated abuse or spam.', ...Array(30).fill('• Attempts to bypass platform restrictions.')].join('\n'),
      ].join('\n\n');
      const chunks = utils.chunkText(doc, 3000);
      assert.equal(chunks.length, 2);
      assert.ok(!/:\**\s*$/.test(chunks[0]), `part 1 must not end with the intro line: …${chunks[0].slice(-40)}`);
      assert.ok(chunks[1].startsWith(intro), `part 2 should start with the intro line, got: ${chunks[1].slice(0, 40)}`);
    }
  });
  check('chunkText never adds a message just for a nicer break', () => {
    const paras = (n, tag) => Array.from({ length: n }, (_, j) => `${tag} paragraph ${j}: plenty of detail about brackets, check-ins and prizes here.`).join('\n\n');
    const doc = `${paras(24, 'Intro')}\n\n## Heading in the middle\n${paras(48, 'Body')}`;
    assert.equal(utils.chunkText(doc, 3000).length, 2, 'cutting at the heading would need 3 messages — the plain split (2) wins');
  });
  check('chunkText never loses text (random documents)', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const norm = (s) => s.replace(/```/g, '').replace(/\s+/g, '');
    for (let doc = 0; doc < 150; doc++) {
      const blocks = [];
      while (blocks.join('\n\n').length < 2500 + rnd() * 6000) {
        blocks.push(
          pick([
            () => `${'#'.repeat(1 + Math.floor(rnd() * 3))} Heading ${blocks.length}`,
            () => 'A sentence about the tournament rules and schedule. '.repeat(1 + Math.floor(rnd() * 12)).trim(),
            () => `The following apply:\n${Array.from({ length: 2 + Math.floor(rnd() * 12) }, (_, i) => `- item ${i} with some words`).join('\n')}`,
            () => `\`\`\`\n${'# not a heading\nline of code\n'.repeat(1 + Math.floor(rnd() * 40))}\`\`\``,
            () => `**Note:**\n${'word '.repeat(Math.floor(rnd() * 300))}`,
          ])(),
        );
      }
      const text = blocks.join(pick(['\n\n', '\n']));
      for (const max of [1000, 1750, 3000]) {
        const chunks = utils.chunkText(text, max);
        for (const c of chunks) {
          assert.ok(c.length <= max, `chunk of ${c.length} > ${max}`);
          assert.equal((c.match(/```/g) || []).length % 2, 0, 'unbalanced fence');
        }
        assert.equal(norm(chunks.join('\n')), norm(text), `text changed (doc ${doc}, max ${max})`);
      }
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
    assert.equal(commands.length, 11);
    const names = commands.map((c) => c.name);
    assert.ok(names.includes('Post as Announcement') && names.includes('announce'));
    const ids = commands.find((c) => c.name === 'ids');
    assert.equal(ids?.default_member_permissions, String(PermissionFlagsBits.ManageGuild), '/ids is for staff');
    const ar = commands.find((c) => c.name === 'autoreact');
    assert.equal(ar?.default_member_permissions, String(PermissionFlagsBits.ManageGuild), '/autoreact is for staff');
    assert.deepEqual(ar.options.map((o) => o.name), ['set', 'add', 'remove', 'list', 'copy', 'template']);
    const tpl = ar.options.find((o) => o.name === 'template');
    assert.equal(tpl.type, 2, 'template is a subcommand group');
    assert.deepEqual(tpl.options.map((o) => o.name), ['create', 'apply', 'edit', 'delete', 'list']);
    for (const sub of ['apply', 'edit', 'delete']) {
      const opt = tpl.options.find((o) => o.name === sub).options[0];
      assert.ok(opt.name === 'name' && opt.required && opt.autocomplete, `${sub}: pick the template from suggestions`);
    }
    const create = tpl.options.find((o) => o.name === 'create').options;
    assert.deepEqual(create.map((o) => [o.name, Boolean(o.required)]), [['name', true], ['from', false]]);
    assert.equal(create[0].max_length, 32);
    assert.deepEqual(ar.options.find((o) => o.name === 'copy').options.map((o) => [o.name, Boolean(o.required)]), [['from', true]]);
    // Discord rejects a command whose required options come after optional ones
    const walk = (opts = []) => {
      const flags = opts.filter((o) => o.type > 2).map((o) => Boolean(o.required));
      assert.ok(flags.indexOf(false) === -1 || flags.lastIndexOf(true) < flags.indexOf(false), 'required options first');
      for (const o of opts) if (o.type <= 2) walk(o.options);
      for (const o of opts) assert.ok(o.description.length >= 1 && o.description.length <= 100, `${o.name}: description length`);
    };
    for (const c of commands) walk(c.options);
    const channelTypes = ar.options[0].options.find((o) => o.name === 'channel').channel_types;
    for (const t of [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.PublicThread]) assert.ok(channelTypes.includes(t));
    assert.equal(ar.options[0].options.find((o) => o.name === 'emojis').required, false, 'empty emojis → pick from a list');
    const react = commands.find((c) => c.name === 'react');
    assert.equal(react?.default_member_permissions, String(PermissionFlagsBits.ManageGuild), '/react is for staff');
    assert.deepEqual(react.options.map((o) => [o.name, Boolean(o.required)]), [['message', true], ['emojis', false], ['channel', false]]);
    const app = commands.find((c) => c.name === 'React as Bot');
    assert.equal(app?.type, 3, 'right-click message app');
    assert.ok(commands.filter((c) => c.type === 3).length <= 5, 'Discord allows 5 message apps');
  });

  await checkAsync('auto reactions: reading the emoji list', async () => {
    const emoji = (id, name, extra = {}) => [id, { id, name, animated: false, available: true, roles: { cache: new Collection() }, ...extra }];
    const myRole = '500000000000000001';
    const server = {
      id: guild.id,
      members: { me: { roles: { cache: new Collection([[myRole, {}]]) } } },
      client: { emojis: { cache: new Collection([emoji('300000000000000099', 'elsewhere')]) } }, // another server the bot is in
      emojis: {
        fetch: async () => {},
        cache: new Collection([
          emoji('300000000000000001', 'aether'),
          emoji('300000000000000002', 'Hype', { animated: true }),
          emoji('300000000000000003', 'gone', { available: false }),
          emoji('300000000000000004', 'vip', { roles: { cache: new Collection([['500000000000000009', {}]]) } }),
          emoji('300000000000000005', 'staff', { roles: { cache: new Collection([[myRole, {}]]) } }),
        ]),
      },
    };
    const ok = await autoReact.parseEmojiList('<:aether:300000000000000001>, :hype: 🔥🔥 👍🏽 1️⃣ 🇮🇳 ❤ :aether: 300000000000000005 <:elsewhere:300000000000000099> 👨‍👩‍👧', server);
    assert.deepEqual(ok.problems, []);
    assert.deepEqual(
      ok.emojis.map((e) => e.id ?? e.name),
      ['300000000000000001', '300000000000000002', '🔥', '👍🏽', '1️⃣', '🇮🇳', '❤️', '300000000000000005', '300000000000000099', '👨‍👩‍👧'],
      'order kept, duplicates dropped, ❤ becomes ❤️',
    );
    assert.deepEqual(ok.emojis[1], { id: '300000000000000002', name: 'Hype', animated: true }, 'the server’s own name and animated flag');
    const bad = await autoReact.parseEmojiList(':nope: <:foreign:399999999999999999> :gone: :vip: hello ? 🔥', server);
    assert.deepEqual(bad.emojis.map((e) => e.name), ['🔥']);
    const why = bad.problems.join('\n');
    assert.equal(bad.problems.length, 6, why);
    for (const bit of ['no emoji called `:nope:`', '`:foreign:` is from a server I’m not in', '`:gone:` is unavailable', '`:vip:` is limited to certain roles', '`hello` isn’t an emoji', 'Not emojis: `?`']) {
      assert.ok(why.includes(bit), `missing: ${bit}\n${why}`);
    }
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
  /** Every Text Display's content, in order (walks containers). */
  const textBlocks = (components) => {
    const out = [];
    const walk = (node) => {
      const j = typeof node?.toJSON === 'function' ? node.toJSON() : node;
      if (Array.isArray(j)) return j.forEach(walk);
      if (!j || typeof j !== 'object') return;
      if (j.type === ComponentType.TextDisplay) out.push(j.content);
      for (const v of Object.values(j)) if (v && typeof v === 'object') walk(v);
    };
    walk(components);
    return out;
  };
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
    // publishedAt is fixed like publish() does, so renders compared below can't straddle a second (card footer timestamp)
    const a = announcements.newSession({ id: '600000000000000001', channelId: '200000000000000001', publishedAt: Date.now(), ...fields, files: fields.files ?? [] });
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
      const posted = announcements.renderParts(a);
      assert.equal(posted.length, parts.length);
      parts.forEach((p, i) => {
        // every part pings the same way (so the whole announcement is gold)
        if (fields.ping) {
          assert.match(JSON.stringify(p.components), /@everyone|<@&\d+>/, `${name}: part ${i + 1} must carry the ping`);
          if (i > 0) assert.match(JSON.stringify(p.components), /↳ Part \d+ of \d+ · (@everyone|<@&\d+>)/, `${name}: part ${i + 1} small ping tag`);
        }
        assert.deepEqual(p.allowedMentions, parts[0].allowedMentions, `${name}: part ${i + 1} mentions differ`);
        // never Discord's "silent" flag: a silent message after a normal one always gets its own name header
        assert.equal(Boolean(p.flags & MessageFlags.SuppressNotifications), false, `${name}: part ${i + 1} must not be silent`);
        assert.deepEqual(posted[i].payload, p);
        const { quiet } = posted[i];
        if (!fields.ping || i === 0) {
          assert.equal(quiet, null, `${name}: part ${i + 1} is posted as it is`);
          return;
        }
        // parts 2+ first arrive "quiet" (ping not switched on → nobody notified), then an edit turns the ping on
        validatePayload(`${name} part ${i + 1} (quiet)`, quiet, { ephemeralOk: false });
        assert.deepEqual(quiet.allowedMentions, { parse: ['users'] }, `${name}: quiet part ${i + 1} must not ping`);
        assert.equal(Boolean(quiet.flags & MessageFlags.SuppressNotifications), false, `${name}: quiet part ${i + 1} must not be silent`);
        assert.ok(!quiet.files?.length, `${name}: quiet part ${i + 1} uploads nothing (files come with the edit)`);
        const q = JSON.stringify(quiet.components);
        assert.ok(!/"type":(12|13)[,}]/.test(q), `${name}: quiet part ${i + 1} must not show files it doesn't have`);
        assert.match(q, /↳ Part \d+ of \d+ · (@everyone|<@&\d+>)/, `${name}: quiet part ${i + 1} already shows the tag (nothing jumps)`);
        assert.deepEqual(textBlocks(quiet.components), textBlocks(p.components), `${name}: quiet part ${i + 1} has exactly the final text`);
      });
      assert.deepEqual(preview.allowedMentions, { parse: [] }, 'previews must never ping');
    });
  }

  // who gets notified: once (default) · every · none (edits and reposts)
  check('announcement notify modes', () => {
    const base = { id: '600000000000000003', channelId: '200000000000000001', title: 'Rules', body: longText, more: longText };
    const pinged = announcements.newSession({ ...base, ping: 'everyone', files: [...mediaFiles, ...docFiles] });
    const every = announcements.renderParts(pinged, { notify: 'every' });
    assert.ok(every.length >= 2, 'long enough to split');
    assert.ok(every.every((p) => p.quiet === null), 'every: each part is posted as it is (each one notifies)');
    const none = announcements.renderParts(pinged, { notify: 'none' });
    none.forEach((p, i) => {
      assert.ok(p.quiet, `none: part ${i + 1} arrives quiet`);
      assert.deepEqual(p.quiet.allowedMentions, { parse: [] }, `none: part ${i + 1} notifies nobody — not even @mentioned users`);
      assert.deepEqual(p.payload.allowedMentions, { parse: ['users', 'everyone'] }, `none: part ${i + 1} is still gold after the edit`);
      assert.ok(!p.quiet.files?.length && !/"type":(12|13)[,}]/.test(JSON.stringify(p.quiet.components)), `none: part ${i + 1} files come with the edit`);
      validatePayload(`none part ${i + 1} (quiet)`, p.quiet, { ephemeralOk: false });
    });
    // nothing to switch on → posted as it is
    assert.ok(announcements.renderParts(announcements.newSession({ ...base, files: [] }), { notify: 'none' }).every((p) => p.quiet === null));
    // an @user mention with no ping: a repost/edit must not notify them again, a normal post does
    const withUser = announcements.newSession({ ...base, body: `GG <@123456789012345678>! ${longText}`, files: [] });
    assert.ok(announcements.renderParts(withUser, { notify: 'none' }).every((p) => p.quiet?.allowedMentions.parse.length === 0));
    assert.ok(announcements.renderParts(withUser).every((p) => p.quiet === null && p.payload.allowedMentions.parse.includes('users')));
    // the preview never pings, in any mode
    for (const notify of ['once', 'every', 'none']) {
      assert.ok(announcements.renderParts(pinged, { preview: true, notify }).every((p) => p.quiet === null && p.payload.allowedMentions.parse.length === 0));
    }
  });

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

  check('emoji picker: pages, search, limits', () => {
    const PAGE = reactPicker.PER_PAGE;
    const make = (n, prefix, animated = true) =>
      Array.from({ length: n }, (_, k) => {
        const id = String(320000000000000000n + BigInt(k + (animated ? 0 : 5000)));
        return [id, { id, name: `${prefix}_${String(k).padStart(3, '0')}_long_name_x`, animated, available: true, roles: { cache: new Collection() } }];
      });
    const server = {
      id: guild.id,
      members: { me: { roles: { cache: new Collection() } } },
      channels: guild.channels,
      emojis: {
        cache: new Collection([
          ...make(250, 'anim'),
          ...make(3, 'still', false),
          ['329999999999999999', { id: '329999999999999999', name: 'vip_only', animated: true, available: true, roles: { cache: new Collection([['1', {}]]) } }],
          ['329999999999999998', { id: '329999999999999998', name: 'no_boost', animated: false, available: false, roles: { cache: new Collection() } }],
        ]),
      },
    };
    const fake = { user: { id: '100000000000000009' }, guildId: guild.id };
    const json = (p) => JSON.stringify(p.components.map((c) => (c.toJSON ? c.toJSON() : c)));
    const selects = (p) => p.components[0].toJSON().components.filter((c) => c.type === 1 && c.components[0].type === 3).map((r) => r.components[0]);
    const buttons = (p) => p.components[0].toJSON().components.filter((c) => c.type === 1 && c.components[0].type === 2).flatMap((r) => r.components);

    const s = reactPicker.newSession(fake, { mode: 'channel', channelId: '200000000000000001', bots: true });
    let p = reactPicker.render(server, s);
    results.push(['emoji picker (253 emojis, page 1)', validatePayload('picker page 1', p)]);
    assert.equal(selects(p).length, 4);
    assert.ok(selects(p).every((m) => m.options.length === 25 && m.max_values === 25 && m.min_values === 0));
    assert.equal(selects(p)[0].options[0].emoji.animated, true, 'animated emojis are shown');
    assert.ok(!json(p).includes('vip_only') && !json(p).includes('no_boost'), 'emojis I can’t use are hidden');
    assert.match(json(p), /Page 1\/3 · 253 emojis · A→Z · 2 hidden/);
    assert.deepEqual(buttons(p).map((b) => b.label), ['Previous', 'Next', 'Search', 'Save (0)', 'Type', 'Clear', 'Cancel']);
    assert.equal(buttons(p)[0].disabled, true);
    assert.equal(buttons(p)[3].disabled, true, 'nothing to save yet');

    s.page = 2;
    p = reactPicker.render(server, s);
    assert.equal(selects(p).length, 3, '253 − 200 = 53 → 3 lists');
    assert.equal(selects(p).at(-1).options.length, 3);
    assert.equal(buttons(p)[1].disabled, true, 'no page after the last');

    s.chosen = server.emojis.cache.filter((e) => e.available).first(20).map((e) => ({ id: e.id, name: e.name, animated: e.animated }));
    s.note = 'Discord allows 20 different reactions per message, so 3 more couldn’t be added.';
    s.page = 0;
    p = reactPicker.render(server, s);
    results.push(['emoji picker (20 chosen + note)', validatePayload('picker full', p)]);
    assert.match(json(p), /Chosen 20\/20/);
    assert.equal(selects(p)[0].options.filter((o) => o.default).length, 20, 'chosen emojis are ticked');

    s.query = 'still';
    p = reactPicker.render(server, s);
    assert.equal(selects(p).length, 1);
    assert.deepEqual(buttons(p).map((b) => b.label).slice(0, 1), ['Clear search']);

    const empty = { ...server, emojis: { cache: new Collection() } };
    const m = reactPicker.newSession(fake, { mode: 'message', channelId: '200000000000000001', messageId: '1', url: 'https://discord.com/channels/1/2/3', authorId: '5', initial: 2 });
    p = reactPicker.render(empty, m);
    results.push(['emoji picker (no custom emojis)', validatePayload('picker empty', p)]);
    assert.equal(selects(p).length, 0);
    assert.match(json(p), /no custom emojis I can use yet/);
    assert.equal(buttons(p).find((b) => b.custom_id.startsWith('ep:ok')).label, 'Remove my reactions', 'everything unticked → take my reactions off');
    assert.ok(PAGE === 100);
  });

  check('auto reactions: list card fits Discord’s limits', () => {
    const saved = store.guild(guild.id).autoReact;
    const big = Array.from({ length: 20 }, (_, i) => ({ id: String(310000000000000000n + BigInt(i)), name: `emoji_with_a_long_name_${String(i).padStart(2, '0')}`, animated: i % 2 === 0 }));
    try {
      store.guild(guild.id).autoReact = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [String(210000000000000000n + BigInt(i)), { emojis: big, bots: i % 2 === 0 }]));
      const card = autoReact.listCard(guild);
      results.push(['auto reactions list (30 channels × 20)', validatePayload('autoreact list', card)]);
      assert.match(JSON.stringify(card.components), /…and \d+ more/);
      store.guild(guild.id).autoReact = { '200000000000000001': { emojis: [{ id: null, name: '🔥', animated: false }, big[0]], bots: false } };
      const small = JSON.stringify(autoReact.listCard(guild).components);
      assert.ok(small.includes('🔥 <a:emoji_with_a_long_name_00:310000000000000000>') && small.includes('👤 members only'));
      store.guild(guild.id).autoReact = {};
      assert.match(JSON.stringify(autoReact.listCard(guild).components), /No auto reactions yet/);
    } finally {
      store.guild(guild.id).autoReact = saved;
    }
  });

  check('emoji templates: channel chooser, cards, limits', () => {
    const CT = ChannelType;
    const chans = new Collection();
    let seq = 220000000000000000n;
    const ch = (name, type, parentId = null, { see = true, react = true } = {}) => {
      const id = String(seq++);
      chans.set(id, { id, name, type, parentId, permissionsFor: () => ({ has: (p) => (p === PermissionFlagsBits.ViewChannel ? see : see && react) }) });
      return id;
    };
    const cat = ch('COMMUNITY', CT.GuildCategory);
    const inCat = Array.from({ length: 6 }, (_, i) => ch(`community-${i}`, i === 5 ? CT.GuildForum : CT.GuildText, cat));
    const voice = ch('Lounge', CT.GuildVoice, cat);
    const loose = Array.from({ length: 40 }, (_, i) => ch(`channel-with-a-long-name-${String(i).padStart(2, '0')}`, CT.GuildText));
    const hidden = ch('staff-only', CT.GuildText, null, { see: false });
    const readOnly = ch('read-only', CT.GuildAnnouncement, null, { react: false });
    const thread = ch('a-thread', CT.PublicThread, loose[0]);
    const list = Array.from({ length: 20 }, (_, i) => ({ id: String(311000000000000000n + BigInt(i)), name: `animated_emoji_long_name_${String(i).padStart(2, '0')}`, animated: true }));
    const server = { id: '100000000000000777', channels: { cache: chans }, emojis: { cache: new Collection(list.map((e) => [e.id, e])) }, members: { me: {} } };
    const g = store.guild(server.id);
    g.reactTemplates = { t00000001: { name: 'Hype *bold*', emojis: list, createdAt: 1, updatedAt: 1 } };
    g.autoReact = { [loose[1]]: { emojis: list, bots: true, template: 't00000001' }, [loose[2]]: { emojis: list.slice(0, 2), bots: false } };
    const fake = { user: { id: '100000000000000009' }, guildId: server.id };
    const json = (p) => JSON.stringify(p.components.map((c) => (c.toJSON ? c.toJSON() : c)));
    const parts = (p) => p.components[0].toJSON().components;
    const buttons = (p) => parts(p).filter((c) => c.type === 1 && c.components[0].type === 2).flatMap((r) => r.components);
    const menus = (p) => parts(p).filter((c) => c.type === 1 && c.components[0].type === 8).map((r) => r.components[0]);
    const chatCount = 6 + 40 + 1; // community + loose + read-only (hidden: can't see it · voice and threads: not chat channels)

    const s = reactTemplates.newSession(fake, { mode: 'template', templateId: 't00000001' });
    let p = reactTemplates.chooser(server, s);
    results.push(['template chooser (nothing picked)', validatePayload('chooser empty', p)]);
    assert.ok(json(p).includes('Use the template “Hype \\\\*bold\\\\*”'), 'name shown with its markdown escaped');
    assert.equal(menus(p).length, 2, 'channels + categories');
    assert.deepEqual(menus(p)[1].channel_types, [CT.GuildCategory]);
    assert.ok(menus(p)[0].channel_types.includes(CT.PublicThread) && menus(p)[0].max_values === 25 && menus(p)[0].min_values === 0);
    assert.deepEqual(buttons(p).map((b) => b.label), [`All chat channels (${chatCount})`, 'Clear', 'Apply', 'Cancel']);
    assert.ok(buttons(p)[2].disabled && buttons(p)[1].disabled, 'nothing to apply or clear yet');

    s.all = true;
    p = reactTemplates.chooser(server, s);
    results.push(['template chooser (all chat channels)', validatePayload('chooser all', p)]);
    assert.ok(json(p).includes(`${chatCount - 1} channels selected`), 'every chat channel I can react in');
    assert.ok(json(p).includes(`+${chatCount - 1 - 20} more`));
    assert.ok(json(p).includes('I can’t react in') && json(p).includes(`<#${readOnly}>`) && json(p).includes('**Add Reactions**'));
    assert.ok(!json(p).includes(`<#${hidden}>`) && !json(p).includes(`<#${voice}>`) && !json(p).includes(`<#${thread}>`));
    assert.ok(json(p).includes('1 of them already has other auto reactions'), 'only the channel with a different list counts as replaced');
    assert.equal(buttons(p)[0].style, 1, 'toggle shows as on');
    assert.equal(buttons(p)[2].label, `Apply to ${chatCount - 1} channels`);

    s.all = false;
    s.categories = [cat];
    s.picked = [voice, thread, loose[3]];
    p = reactTemplates.chooser(server, s);
    assert.ok(json(p).includes('9 channels selected'), '6 in the category + 3 picked one by one (voice and threads only when picked)');
    assert.deepEqual(menus(p)[0].default_values.map((d) => d.id), [voice, thread, loose[3]]);
    assert.deepEqual(menus(p)[1].default_values.map((d) => d.id), [cat]);

    const copy = reactTemplates.newSession(fake, { mode: 'copy', sourceId: loose[2], all: true });
    p = reactTemplates.chooser(server, copy);
    results.push(['copy chooser (all chat channels)', validatePayload('copy all', p)]);
    assert.ok(json(p).includes('Copy auto reactions') && json(p).includes('👤 members only'));
    assert.ok(json(p).includes(`All chat channels (${chatCount - 1})`), 'the source channel itself is left out');

    // the template list: 25 templates with 20 emojis each, all in the menus
    g.reactTemplates = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`t${String(i).padStart(8, '0')}`, { name: `Template number ${i}`, emojis: list }]));
    const card = reactTemplates.templateListCard(server);
    results.push(['template list (25 × 20 emojis)', validatePayload('template list', card)]);
    const lists = parts(card).filter((c) => c.type === 1).map((r) => r.components[0]);
    assert.deepEqual(lists.map((l) => [l.custom_id, l.options.length]), [['rt:apply', 25], ['rt:edit', 25]]);
    assert.match(json(card), /…and \d+ more/);
    assert.equal(reactTemplates.templateChoices(server, 'number 1').length, 11, '1 and 10-19');
    g.reactTemplates = {};
    assert.match(json(reactTemplates.templateListCard(server)), /No templates yet/);
  });

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
