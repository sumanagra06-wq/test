'use strict';
/**
 * Generates docs/previews/ui-preview.html — a Discord-style mock-up of every panel/message,
 * rendered from the bot's REAL payloads (same functions the bot uses). Run: npm run preview
 */
process.env.DISCORD_TOKEN ||= 'preview';
const fs = require('node:fs');
const path = require('node:path');
const { Collection } = require('discord.js');
const { createCanvas } = require('@napi-rs/canvas');
const config = require('../src/config');
const buttonRoles = require('../src/features/buttonRoles');
const reactionRoles = require('../src/features/reactionRoles');
const announcements = require('../src/features/announcements');
const welcome = require('../src/features/welcome');
const help = require('../src/features/help');
const store = require('../src/lib/store');
const { toJSON } = require('../tests/helpers/validate');

const OUT = path.join(__dirname, '..', 'docs', 'previews');
fs.mkdirSync(OUT, { recursive: true });

/* ───────────── generated artwork (data URIs so the page works offline) ───────────── */
function art(w, h, draw) {
  const c = createCanvas(w, h);
  draw(c.getContext('2d'), w, h);
  return c;
}
const dataUri = (canvas, type = 'image/png') => `data:${type};base64,${canvas.toBuffer(type).toString('base64')}`;
function aether(ctx, w, h) {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#0b0a1f');
  g.addColorStop(1, '#170d3a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  for (const [x, y, r, col] of [
    [w * 0.15, h * 0.1, w * 0.6, 'rgba(124,92,255,0.55)'],
    [w * 0.95, h * 1.1, w * 0.55, 'rgba(34,211,238,0.35)'],
  ]) {
    const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, col);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, w, h);
  }
}
const icon = art(256, 256, (ctx, w, h) => {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#7c5cff');
  g.addColorStop(1, '#22d3ee');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  ctx.font = '800 110px Poppins';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('AB', w / 2, h / 2 + 8);
});
const avatar = art(256, 256, (ctx, w, h) => {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#f97316');
  g.addColorStop(1, '#ec4899');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.beginPath();
  ctx.arc(w / 2, h * 0.4, 52, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(w / 2, h * 0.95, 95, 75, 0, 0, Math.PI * 2);
  ctx.fill();
});
function bannerArt(title, subtitle) {
  return art(1200, 420, (ctx, w, h) => {
    aether(ctx, w, h);
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 84px Poppins';
    ctx.fillText(title, 70, 230);
    ctx.font = '600 30px Poppins';
    ctx.letterSpacing = '6px';
    ctx.fillStyle = '#22d3ee';
    ctx.fillText(subtitle, 74, 120);
  });
}

/* ───────────── mock server ───────────── */
const roleData = {};
const roles = new Collection();
let rid = 420000000000000000n;
function addRole(name, color) {
  const id = String(rid++);
  roleData[id] = { name, color };
  roles.set(id, { id, name, position: 10, managed: false, mentionable: true });
  return id;
}
const guild = {
  id: '100000000000000001',
  name: 'AetherBrackets',
  memberCount: 1284,
  iconURL: () => 'https://cdn.discordapp.com/icons/guild.png',
  roles: { cache: roles },
  channels: { cache: new Collection() },
  emojis: { cache: new Collection() },
};
const channelNames = { 1: 'rules', 2: 'get-roles', 3: 'announcements', 4: 'registrations' };

function panelFrom(style, mode, list, extra = {}) {
  return {
    id: 'k3j9x2',
    channelId: '1',
    messageId: '2',
    title: extra.title ?? '🎮 Pick your games',
    description: extra.description ?? 'Grab the roles for the games you play — you’ll get pinged for **brackets, scrims & watch parties**.',
    footer: '',
    color: extra.color ?? null,
    style,
    mode,
    bannerUrl: null,
    bannerFile: extra.bannerFile ?? null,
    roles: list.map(([emoji, label, color, description, buttonColor = 'grey']) => ({
      roleId: addRole(label, color),
      label,
      emoji: { id: null, name: emoji },
      description,
      buttonColor,
    })),
  };
}

/* ───────────── mini Discord renderer ───────────── */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const hex = (n) => `#${(n ?? 0x7c5cff).toString(16).padStart(6, '0')}`;

function inline(raw) {
  let s = esc(raw);
  s = s.replace(/&lt;@&amp;(\d+)&gt;/g, (_, id) => {
    const r = roleData[id] ?? { name: 'role', color: '#b5bac1' };
    return `<span class="pill" style="--c:${r.color}">@${esc(r.name)}</span>`;
  });
  s = s.replace(/&lt;#(\d+)&gt;/g, (_, id) => `<span class="pill ch">#${channelNames[id] ?? 'channel'}</span>`);
  s = s.replace(/&lt;@(\d+)&gt;/g, () => '<span class="pill user">@NovaStrike</span>');
  s = s.replace(/&lt;t:(\d+):\w&gt;/g, (_, t) => `<span class="ts">${new Date(Number(t) * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>`);
  s = s.replace(/&lt;a?:(\w+):\d+&gt;/g, (_, n) => `<span class="cemoji" title=":${n}:"></span>`);
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a>$1</a>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<i>$2</i>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  if (s === '@everyone' || s === '@here') s = `<span class="pill">${s}</span>`;
  return s;
}

function markdown(text) {
  let quote = false;
  const out = [];
  for (let line of String(text).split('\n')) {
    if (line.startsWith('>>> ')) {
      quote = true;
      line = line.slice(4);
      out.push('<div class="quote">');
    }
    let cls = 'p';
    for (const [re, c] of [[/^### /, 'h3'], [/^## /, 'h2'], [/^# /, 'h1'], [/^-# /, 'sub'], [/^[•▸] /, 'p']]) {
      if (re.test(line)) {
        cls = c;
        if (c !== 'p') line = line.replace(re, '');
        break;
      }
    }
    if (/^- /.test(line)) {
      cls = 'li';
      line = line.slice(2);
    }
    out.push(`<div class="${cls}">${inline(line) || '&nbsp;'}</div>`);
  }
  if (quote) out.push('</div>');
  return out.join('');
}

function emojiHtml(e) {
  if (!e) return '';
  return e.id ? '<span class="cemoji"></span>' : `<span class="em">${esc(e.name)}</span>`;
}

function render(c, img) {
  switch (c.type) {
    case 17:
      return `<div class="container" style="--accent:${hex(c.accent_color)}">${c.components.map((x) => render(x, img)).join('')}</div>`;
    case 10:
      return `<div class="td">${markdown(c.content)}</div>`;
    case 9:
      return `<div class="section"><div class="stext">${c.components.map((x) => render(x, img)).join('')}</div><div class="acc">${render(c.accessory, img)}</div></div>`;
    case 11:
      return `<img class="thumb" src="${img(c.media.url)}" alt="">`;
    case 14:
      return `<div class="${c.divider === false ? 'spacer' : 'sep'} ${c.spacing === 2 ? 'lg' : ''}"></div>`;
    case 12:
      return `<div class="gallery g${Math.min(c.items.length, 4)}">${c.items.map((i) => `<img src="${img(i.media.url)}" alt="">`).join('')}</div>`;
    case 13: {
      const name = c.file.url.replace('attachment://', '');
      return `<div class="file"><div class="ficon">📄</div><div><div class="fname">${esc(name)}</div><div class="fsize">248.1 KB</div></div><div class="dl">⬇</div></div>`;
    }
    case 1:
      return `<div class="row">${c.components.map((x) => render(x, img)).join('')}</div>`;
    case 2:
      return `<button class="btn s${c.style}" ${c.disabled ? 'disabled' : ''}>${emojiHtml(c.emoji)}${c.label ? `<span>${esc(c.label)}</span>` : ''}${c.style === 5 ? '<span class="ext">↗</span>' : ''}</button>`;
    case 3: {
      const chosen = c.options.filter((o) => o.default);
      const inner = chosen.length
        ? chosen.map((o) => `<span class="chip">${emojiHtml(o.emoji)}${esc(o.label)}</span>`).join('')
        : `<span class="ph">${esc(c.placeholder ?? 'Make a selection')}</span>`;
      return `<div class="select">${inner}<span class="chev">⌄</span></div>`;
    }
    default:
      return '';
  }
}

function message(payload, { img, ephemeral = false, reactions = null, time = 'Today at 18:30' } = {}) {
  const comps = payload.components.map(toJSON).map((c) => render(c, img)).join('');
  const react = reactions ? `<div class="reactions">${reactions.map(([e, n, me]) => `<span class="reaction ${me ? 'me' : ''}">${e}<b>${n}</b></span>`).join('')}</div>` : '';
  const eph = ephemeral ? '<div class="eph">👁 Only you can see this · <a>Dismiss message</a></div>' : '';
  return `<div class="msg"><img class="avatar" src="${iconUri}" alt=""><div class="mbody"><div class="meta"><span class="bname">${esc(config.brand.name)}</span><span class="app">✓ APP</span><span class="time">${time}</span></div>${comps}${react}${eph}</div></div>`;
}

const iconUri = dataUri(icon);
const avatarUri = dataUri(avatar);

(async () => {
  const gamesBanner = dataUri(bannerArt('Platform & Region', 'CUSTOMISE YOUR PROFILE'), 'image/jpeg');
  const seasonBanner = dataUri(bannerArt('Season 3 is here', 'OFFICIAL · AETHERBRACKETS'), 'image/jpeg');
  const imgFor = (map) => (url) => {
    if (map[url]) return map[url];
    if (url.includes('/icons/')) return iconUri;
    return avatarUri;
  };

  /* panels */
  const list = panelFrom('list', 'toggle', [
    ['🎯', 'Valorant', '#ff4655', 'Pings for Valorant brackets & scrims', 'grey'],
    ['🚗', 'Rocket League', '#3b82f6', '3v3 cups every Saturday', 'grey'],
    ['♟️', 'Chess', '#e5e7eb', 'Weekly blitz arena', 'grey'],
    ['🏆', 'Tournament Alerts', '#f5b301', 'Get notified when registrations open', 'blue'],
    ['📺', 'Watch Parties', '#a855f7', 'Finals viewing & co-streams', 'grey'],
  ]);
  const grid = panelFrom(
    'buttons',
    'toggle',
    [
      ['🖥️', 'PC', '#60a5fa'],
      ['🎮', 'PlayStation', '#2563eb'],
      ['🟩', 'Xbox', '#22c55e'],
      ['📱', 'Mobile', '#f472b6'],
      ['🕹️', 'Switch', '#ef4444'],
      ['🌏', 'Asia', '#14b8a6'],
      ['🌍', 'Europe', '#8b5cf6'],
      ['🌎', 'Americas', '#f97316'],
      ['🇮🇳', 'India', '#f59e0b'],
      ['🌐', 'Other', '#9ca3af'],
    ],
    { title: '🌐 Platform & region', description: 'So we can seed you into the right lobbies.', bannerFile: 'banner.jpg', color: 0x22d3ee },
  );
  const dropdown = panelFrom(
    'dropdown',
    'toggle',
    [
      ['📢', 'Announcements', '#7c5cff', 'Big news only'],
      ['🗓️', 'Events', '#22d3ee', 'Community nights & game days'],
      ['🧪', 'Beta Testers', '#84cc16', 'Try new bracket features first'],
      ['🎥', 'Content Creators', '#ec4899', 'Share streams & clips'],
      ['🤝', 'LFG', '#f97316', 'Looking for a team'],
      ['🧠', 'Strategy Talk', '#eab308', 'Theorycrafting & VOD reviews'],
    ],
    { title: '🔔 Notification roles', description: 'Choose what you want to hear about. You can change this any time.' },
  );
  const unique = panelFrom(
    'list',
    'unique',
    [
      ['🥇', 'Gold Division', '#f5b301', 'Top 64 seeded players'],
      ['🥈', 'Silver Division', '#cbd5e1', 'Competitive, open entry'],
      ['🥉', 'Bronze Division', '#d97706', 'New to brackets? Start here'],
    ],
    { title: '⚔️ Choose your division', description: 'You can be in **one** division per season.', color: 0xf5b301 },
  );

  const panelHtml = (p, extra = {}) => message(buttonRoles.renderPanel(guild, p), { img: imgFor({ 'attachment://banner.jpg': gamesBanner }), ...extra });
  const have = new Set([list.roles[0].roleId, list.roles[3].roleId]);
  const manager = buttonRoles.renderManager(guild, list, have, `✅ Added <@&${list.roles[0].roleId}>`);
  const managerSelect = buttonRoles.renderManager(guild, dropdown, new Set([dropdown.roles[0].roleId, dropdown.roles[1].roleId]));
  const result = buttonRoles.resultCard(list, { added: [list.roles[0].roleId] });
  const swapped = buttonRoles.resultCard(unique, { added: [unique.roles[0].roleId], removed: [unique.roles[1].roleId] });

  /* reaction roles */
  const rrRoles = [
    ['🔴', 'Red Team', '#ef4444'],
    ['🔵', 'Blue Team', '#3b82f6'],
    ['🟢', 'Green Team', '#22c55e'],
    ['🟡', 'Yellow Team', '#facc15'],
  ].map(([e, n, c]) => ({ key: e, emoji: { id: null, name: e }, roleId: addRole(n, c), description: null }));
  const rr = reactionRoles.renderPanel(guild, {
    mode: 'unique',
    panel: { title: '🏁 Pick your team for Community Night', description: 'Teams are balanced every Friday. React to join one.', color: 0xef4444 },
    entries: rrRoles,
  });

  /* announcements */
  const regsRole = addRole('Tournament Alerts', '#f5b301');
  const ann = announcements.newSession({
    id: '1',
    channelId: '3',
    title: 'Season 3 registrations are OPEN!',
    body: [
      'The wait is over — **AetherBrackets Season 3** kicks off on **October 10**.',
      '',
      '- 🏆 ₹50,000 prize pool across 4 games',
      '- ⚔️ Double-elimination brackets with seeded divisions',
      '- 📺 Casted finals on our stream',
      '',
      'Register in <#4> before **October 7**. Full rules are attached below.',
    ].join('\n'),
    footer: '— The AetherBrackets Team',
    ping: 'everyone',
    files: [
      { name: 'season3.jpg', kind: 'image', buffer: Buffer.alloc(1), size: 1, spoiler: false },
      { name: 'Season3_Rules.pdf', kind: 'file', buffer: Buffer.alloc(1), size: 1, spoiler: false },
    ],
    publishedAt: Date.UTC(2026, 8, 28, 13, 0),
  });
  const annParts = announcements.renderAnnouncement(ann);
  const annPreview = announcements.renderPreview({ ...guild, roles: { cache: new Collection([[regsRole, { name: 'Tournament Alerts' }]]) } }, ann);
  const plain = announcements.renderAnnouncement({ ...ann, style: 'plain', ping: regsRole, files: [], title: 'Server maintenance tonight', body: 'The bracket site will be down from **02:00–03:00 IST** for upgrades. Matches in progress are safe.', footer: '' });

  /* welcome — built with the real welcome builder (avatar served from a data: URL) */
  const member = {
    id: '7',
    guild,
    displayName: 'NovaStrike',
    user: { username: 'novastrike' },
    joinedTimestamp: Date.now(),
    displayAvatarURL: () => 'https://preview.local/avatar.png',
  };
  // serve the sample avatar for the welcome banner without touching the network
  const realFetch = global.fetch;
  global.fetch = async (url, opts) =>
    String(url).startsWith('https://preview.local/')
      ? new Response(avatar.toBuffer('image/png'), { headers: { 'content-type': 'image/png' } })
      : realFetch(url, opts);
  const wcfg = { ...store.defaults.defaultGuild().welcome, enabled: true, channelId: '9', rulesChannelId: '1', rolesChannelId: '2' };
  const wImage = await welcome.buildWelcomePayload(member, wcfg, { preview: true });
  const card = wImage.files[0].attachment;
  fs.writeFileSync(path.join(OUT, 'welcome-card.png'), card);
  const cardUri = `data:image/png;base64,${card.toString('base64')}`;
  const wText = await welcome.buildWelcomePayload(member, { ...wcfg, image: false }, { preview: true });

  const helpPayload = help.helpCard(guild, { displayAvatarURL: () => 'https://cdn.discordapp.com/icons/bot.png' });

  const sections = [
    ['Button roles · List style', 'Each role gets its own row with an emoji, description and a <b>Get</b> button. Clicking replies privately — the panel never changes for others.', panelHtml(list)],
    ['Button roles · Button grid + banner', 'Compact emoji buttons (up to 20 roles) with an optional banner image and custom accent colour.', panelHtml(grid)],
    ['Button roles · Dropdown style', 'A clean overview; <b>Choose roles</b> opens a personal menu pre-filled with the member’s current roles (up to 25).', panelHtml(dropdown)],
    ['“One at a time” mode', 'Perfect for divisions/teams — picking a role swaps out the previous one automatically.', panelHtml(unique)],
    ['What the member sees after clicking', 'Private confirmation cards (only the clicker sees them).', message(result, { img: imgFor({}), ephemeral: true }) + message(swapped, { img: imgFor({}), ephemeral: true })],
    ['👤 My roles — personal manager', 'Live view of the member’s roles with Add/Remove buttons that update in place.', message(manager, { img: imgFor({}), ephemeral: true })],
    ['👤 My roles — menu version', 'Used for dropdown panels and panels with 12+ roles: a multi-select that syncs roles in one go.', message(managerSelect, { img: imgFor({}), ephemeral: true })],
    ['Reaction roles', 'Bot-made panels list their emoji → role pairs automatically. You can also attach reaction roles to any existing message.', message(rr, { img: imgFor({}), reactions: [['🔴', 12], ['🔵', 9, true], ['🟢', 11], ['🟡', 7]] })],
    ['Official announcement · Card style', 'Posted under the bot’s name with a banner, markdown, downloadable files, a footer and a localised timestamp. The ping sits above the card.', message(annParts[0], { img: imgFor({ 'attachment://season3.jpg': seasonBanner }) })],
    ['Official announcement · Plain style', 'Clean text without the box — still with title and role ping.', message(plain[0], { img: imgFor({}) })],
    ['Announcement preview (only you see this)', 'Every announcement is previewed privately first — Publish, Edit, switch style, or Discard.', message(annPreview, { img: imgFor({ 'attachment://season3.jpg': seasonBanner }), ephemeral: true })],
    ['Welcome · Image banner mode', 'Generated banner with the member’s avatar, name and member number, plus quick-link buttons.', message(wImage, { img: imgFor({ 'attachment://welcome.png': cardUri }) })],
    ['Welcome · Text card mode', 'Switch with <code>/welcome image enabled:false</code> — a clean card with the avatar on the side.', message(wText, { img: imgFor({}) })],
    ['/help', 'Every command in one place — command names are clickable in Discord.', message(helpPayload, { img: imgFor({}), ephemeral: true })],
  ];

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(config.brand.name)} Bot — UI preview</title>
<style>
:root{--bg:#313338;--bg2:#2b2d31;--text:#dbdee1;--muted:#949ba4;--link:#00a8fc}
*{box-sizing:border-box}body{margin:0;background:#1e1f22;color:var(--text);font:16px/1.375 "gg sans","Noto Sans","Segoe UI",Roboto,Helvetica,Arial,sans-serif}
header{padding:36px 24px 12px;max-width:1000px;margin:0 auto}header h1{margin:0 0 6px;font-size:28px;color:#fff}header p{margin:0;color:var(--muted)}
.grid{max-width:1000px;margin:0 auto;padding:12px 24px 60px;display:grid;gap:22px}
.card{background:var(--bg);border-radius:12px;overflow:hidden;box-shadow:0 1px 0 rgba(0,0,0,.2)}
.card>h2{margin:0;padding:14px 18px 2px;font-size:15px;color:#fff;letter-spacing:.2px}.card>p{margin:0;padding:0 18px 10px;color:var(--muted);font-size:13.5px}
.msg{display:flex;gap:16px;padding:10px 18px 18px}.avatar{width:40px;height:40px;border-radius:50%;flex:none}
.mbody{min-width:0;flex:1;max-width:560px}.meta{display:flex;align-items:center;gap:6px;margin-bottom:4px}.bname{color:#fff;font-weight:600}
.app{background:#5865f2;color:#fff;font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px}.time{color:var(--muted);font-size:12px;margin-left:2px}
.container{background:var(--bg2);border:1px solid rgba(255,255,255,.06);border-left:4px solid var(--accent);border-radius:8px;padding:14px 16px;display:flex;flex-direction:column;gap:8px;margin:4px 0}
.td .p,.td .li{white-space:pre-wrap;word-wrap:break-word}.td .li{padding-left:18px;position:relative}.td .li:before{content:"•";position:absolute;left:4px}
.h1{font-size:24px;font-weight:700;color:#fff;line-height:1.25;margin:2px 0 4px}.h2{font-size:20px;font-weight:700;color:#fff;margin:2px 0 2px}.h3{font-size:16px;font-weight:700;color:#fff}
.sub{font-size:12.5px;color:var(--muted)}b{color:#fff}code{background:#1e1f22;padding:1px 4px;border-radius:4px;font-size:13px}a{color:var(--link);cursor:pointer}
.quote{border-left:4px solid #4e5058;padding-left:10px}
.section{display:flex;gap:14px;align-items:center;justify-content:space-between}.stext{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}.acc{flex:none}
.thumb{width:84px;height:84px;border-radius:8px;object-fit:cover}
.sep{height:1px;background:rgba(255,255,255,.08);margin:2px 0}.sep.lg{margin:8px 0}.spacer{height:4px}.spacer.lg{height:14px}
.gallery{display:grid;gap:4px;border-radius:8px;overflow:hidden}.gallery img{width:100%;display:block;object-fit:cover}.gallery.g2{grid-template-columns:1fr 1fr}.gallery.g3,.gallery.g4{grid-template-columns:1fr 1fr}
.row{display:flex;flex-wrap:wrap;gap:8px}
.btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 16px;border-radius:8px;border:0;color:#fff;font:500 14px inherit;font-family:inherit;cursor:pointer;transition:filter .15s}
.btn:hover{filter:brightness(1.12)}.btn.s1{background:#5865f2}.btn.s2{background:#4e5058}.btn.s3{background:#248046}.btn.s4{background:#da373c}.btn.s5{background:#4e5058}.btn[disabled]{opacity:.5;cursor:not-allowed}
.btn .ext{opacity:.8;font-size:12px}.em{font-size:17px;line-height:1}
.select{display:flex;align-items:center;gap:6px;flex-wrap:wrap;background:#1e1f22;border:1px solid #1e1f22;border-radius:8px;min-height:40px;padding:6px 36px 6px 10px;position:relative;width:100%}
.select .ph{color:var(--muted)}.chip{display:inline-flex;align-items:center;gap:4px;background:#3f4147;border-radius:6px;padding:2px 8px;font-size:14px}.chev{position:absolute;right:12px;top:8px;color:var(--muted)}
.file{display:flex;align-items:center;gap:12px;background:#2b2d31;border:1px solid #1e1f22;border-radius:8px;padding:12px;max-width:420px;background:rgba(0,0,0,.18)}.ficon{font-size:28px}.fname{color:var(--link)}.fsize{font-size:12px;color:var(--muted)}.dl{margin-left:auto;color:var(--muted);font-size:20px}
.pill{background:color-mix(in srgb,var(--c,#5865f2) 18%,transparent);color:var(--c,#c9cdfb);border-radius:4px;padding:0 3px;font-weight:500}
.pill.ch,.pill.user{--c:#c9cdfb;background:rgba(88,101,242,.3)}.ts{background:rgba(255,255,255,.06);border-radius:4px;padding:0 3px}
.cemoji{display:inline-block;width:18px;height:18px;border-radius:50%;background:linear-gradient(135deg,#7c5cff,#22d3ee);vertical-align:-3px}
.reactions{display:flex;gap:4px;margin-top:4px}.reaction{display:inline-flex;gap:6px;align-items:center;background:#2b2d31;border:1px solid transparent;border-radius:8px;padding:2px 8px;font-size:15px}.reaction b{font-size:13px;color:var(--muted)}.reaction.me{background:rgba(88,101,242,.15);border-color:#5865f2}.reaction.me b{color:#c9cdfb}
.eph{font-size:12px;color:var(--muted);margin-top:6px}
footer{text-align:center;color:var(--muted);font-size:12.5px;padding:0 0 40px}
</style></head><body>
<header><h1>${esc(config.brand.name)} Bot — UI preview</h1><p>Rendered from the bot’s real message payloads (Discord Components V2). Colours, emoji and text are all customisable.</p></header>
<div class="grid">${sections.map(([t, d, h]) => `<section class="card"><h2>${t}</h2><p>${d}</p>${h}</section>`).join('\n')}</div>
<footer>Approximate Discord styling · actual look follows each member’s Discord theme</footer>
</body></html>`;
  fs.writeFileSync(path.join(OUT, 'ui-preview.html'), html);
  console.log(`✅ Wrote docs/previews/ui-preview.html (${(html.length / 1024).toFixed(0)} KB) and docs/previews/welcome-card.png`);
})();
