'use strict';
const path = require('node:path');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const { rgba } = require('./color');
const log = require('./log');

/**
 * Renders the welcome banner:  glowing avatar · "WELCOME TO …" · big name · member pill,
 * on an "aether" gradient with a faint tournament-bracket motif (or a custom background).
 */

const W = 1200;
const H = 480;
const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');

let fontsReady = false;
function ensureFonts() {
  if (fontsReady) return;
  const files = [
    ['Poppins-Regular.ttf', 'Poppins'],
    ['Poppins-Medium.ttf', 'Poppins'],
    ['Poppins-SemiBold.ttf', 'Poppins'],
    ['Poppins-Bold.ttf', 'Poppins'],
    ['Poppins-ExtraBold.ttf', 'Poppins'],
    ['NotoSans.ttf', 'Noto Sans'],
  ];
  for (const [file, family] of files) {
    try {
      GlobalFonts.registerFromPath(path.join(FONT_DIR, file), family);
    } catch (err) {
      log.warn(`Font ${file} could not be loaded:`, err.message);
    }
  }
  fontsReady = true;
}

const font = (weight, size) => `${weight} ${size}px Poppins, "Noto Sans", sans-serif`;

/** Deterministic RNG so each member always gets the same star field. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFrom(str) {
  let h = 2166136261;
  for (const ch of String(str)) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return h >>> 0;
}

/** Removes emoji / fancy unicode that fonts can't draw; falls back to the username. */
function drawableName(displayName, username) {
  const clean = (s) =>
    String(s || '')
      .normalize('NFKC')
      .replace(/[\p{Extended_Pictographic}\u200d\uFE0F\u20E3]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  const supported = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Devanagari}\p{Script=Common}\p{Script=Inherited}]+$/u;
  const name = clean(displayName);
  if (name && supported.test(name)) return name;
  return clean(username) || 'New member';
}

function radial(ctx, x, y, r, color) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function drawCover(ctx, img, x, y, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}

function ellipsize(ctx, str, maxWidth) {
  if (ctx.measureText(str).width <= maxWidth) return str;
  let s = str;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

/** A faint single-elimination bracket (8 → 4 → 2 → 🏆) on the right side. */
function drawBracket(ctx, brand, glow) {
  const x0 = 770;
  const colGap = 112;
  const slotW = 78;
  const slotH = 20;
  let ys = Array.from({ length: 8 }, (_, i) => 78 + (402 - 78) * (i / 7));
  ctx.save();
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let round = 0; round < 3; round++) {
    const x = x0 + round * colGap;
    const alpha = 0.06 + round * 0.035;
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    for (const y of ys) {
      ctx.beginPath();
      ctx.roundRect(x, y - slotH / 2, slotW, slotH, 10);
      ctx.fill();
    }
    ctx.strokeStyle = `rgba(255,255,255,${alpha + 0.04})`;
    const next = [];
    for (let i = 0; i < ys.length; i += 2) {
      const a = ys[i];
      const b = ys[i + 1];
      const mid = (a + b) / 2;
      const xr = x + slotW;
      const xm = xr + (colGap - slotW) / 2;
      ctx.beginPath();
      ctx.moveTo(xr + 4, a);
      ctx.lineTo(xm, a);
      ctx.lineTo(xm, b);
      ctx.lineTo(xr + 4, b);
      ctx.moveTo(xm, mid);
      ctx.lineTo(x + colGap - 4, mid);
      ctx.stroke();
      next.push(mid);
    }
    ys = next;
  }
  // champion node
  const fx = x0 + 3 * colGap + 16;
  const fy = ys[0];
  radial(ctx, fx, fy, 90, rgba(glow, 0.35));
  const ring = ctx.createLinearGradient(fx - 16, fy - 16, fx + 16, fy + 16);
  ring.addColorStop(0, rgba(brand, 0.9));
  ring.addColorStop(1, rgba(glow, 0.9));
  ctx.beginPath();
  ctx.arc(fx, fy, 14, 0, Math.PI * 2);
  ctx.lineWidth = 3;
  ctx.strokeStyle = ring;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(fx, fy, 5, 0, Math.PI * 2);
  ctx.fillStyle = rgba(glow, 0.95);
  ctx.fill();
  ctx.restore();
}

function drawPill(ctx, x, y, label, { fill, stroke, color, weight = 700, size = 19, spacing = 2 }) {
  ctx.save();
  ctx.font = font(weight, size);
  ctx.letterSpacing = `${spacing}px`;
  const w = Math.ceil(ctx.measureText(label).width) + 40;
  const h = 46;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + 20, y + h / 2 + 1);
  ctx.restore();
  return w;
}

/**
 * @param {object} o
 * @param {Buffer|null} o.avatar       avatar image bytes
 * @param {string} o.displayName
 * @param {string} o.username
 * @param {number} o.memberCount
 * @param {string} o.serverName
 * @param {string} o.subtitle
 * @param {Buffer|null} o.background   optional custom background image bytes
 * @param {number} o.brand             accent colour
 * @param {number} o.glow              secondary colour
 * @returns {Promise<Buffer>} PNG
 */
async function renderWelcomeCard(o) {
  ensureFonts();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const { brand, glow } = o;

  /* background */
  let customBg = null;
  if (o.background) {
    try {
      customBg = await loadImage(o.background);
    } catch (err) {
      log.warn('Custom welcome background could not be loaded:', err.message);
    }
  }
  if (customBg) {
    drawCover(ctx, customBg, 0, 0, W, H);
    const shade = ctx.createLinearGradient(0, 0, W, 0);
    shade.addColorStop(0, 'rgba(8,7,22,0.90)');
    shade.addColorStop(0.55, 'rgba(8,7,22,0.72)');
    shade.addColorStop(1, 'rgba(8,7,22,0.45)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, W, H);
    radial(ctx, 200, 240, 420, rgba(brand, 0.35));
  } else {
    const base = ctx.createLinearGradient(0, 0, W, H);
    base.addColorStop(0, '#0b0a1f');
    base.addColorStop(1, '#140b30');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);
    radial(ctx, 170, 40, 600, rgba(brand, 0.55));
    radial(ctx, 1150, 520, 560, rgba(glow, 0.33));
    radial(ctx, 760, -80, 380, 'rgba(244,114,182,0.14)');
    const rand = mulberry32(seedFrom(o.username || 'x'));
    for (let i = 0; i < 120; i++) {
      const x = rand() * W;
      const y = rand() * H;
      const r = rand() * 1.4 + 0.3;
      ctx.fillStyle = `rgba(255,255,255,${(0.1 + rand() * 0.5).toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // bracket motif on its own layer, faded in from the right so it never fights the text
    const layer = createCanvas(W, H);
    const lctx = layer.getContext('2d');
    drawBracket(lctx, brand, glow);
    lctx.globalCompositeOperation = 'destination-in';
    const fade = lctx.createLinearGradient(760, 0, 1010, 0);
    fade.addColorStop(0, 'rgba(0,0,0,0)');
    fade.addColorStop(1, 'rgba(0,0,0,1)');
    lctx.fillStyle = fade;
    lctx.fillRect(0, 0, W, H);
    ctx.drawImage(layer, 0, 0);
  }

  /* glass frame */
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(24, 24, W - 48, H - 48, 30);
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  ctx.fill();
  const frame = ctx.createLinearGradient(24, 24, W - 24, H - 24);
  frame.addColorStop(0, rgba(brand, 0.75));
  frame.addColorStop(0.5, 'rgba(255,255,255,0.08)');
  frame.addColorStop(1, rgba(glow, 0.6));
  ctx.strokeStyle = frame;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  /* avatar */
  const cx = 235;
  const cy = 240;
  const r = 128;
  ctx.save();
  ctx.shadowColor = rgba(brand, 0.9);
  ctx.shadowBlur = 70;
  ctx.beginPath();
  ctx.arc(cx, cy, r + 10, 0, Math.PI * 2);
  ctx.fillStyle = rgba(brand, 0.35);
  ctx.fill();
  ctx.restore();

  const ring = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
  ring.addColorStop(0, rgba(brand, 1));
  ring.addColorStop(1, rgba(glow, 1));
  ctx.beginPath();
  ctx.arc(cx, cy, r + 10, 0, Math.PI * 2);
  ctx.lineWidth = 7;
  ctx.strokeStyle = ring;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
  ctx.fillStyle = '#0d0b22';
  ctx.fill();

  const name = drawableName(o.displayName, o.username);
  let avatarImg = null;
  if (o.avatar) {
    try {
      avatarImg = await loadImage(o.avatar);
    } catch (err) {
      log.warn('Avatar could not be loaded:', err.message);
    }
  }
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  if (avatarImg) {
    ctx.drawImage(avatarImg, cx - r, cy - r, r * 2, r * 2);
  } else {
    const fill = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    fill.addColorStop(0, rgba(brand, 1));
    fill.addColorStop(1, rgba(glow, 1));
    ctx.fillStyle = fill;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.fillStyle = '#ffffff';
    ctx.font = font(800, 110);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText([...name][0]?.toUpperCase() || '?', cx, cy + 6);
  }
  ctx.restore();

  /* text block — measured first, then vertically centred on the avatar */
  const tx = 432;
  const maxW = W - tx - 72;

  // eyebrow: WELCOME TO SERVER
  let eyebrow = `WELCOME TO ${String(o.serverName || '').toUpperCase()}`.trim();
  let eyebrowSize = 24;
  let spacing = 6;
  ctx.save();
  ctx.font = font(600, eyebrowSize);
  ctx.letterSpacing = `${spacing}px`;
  while (ctx.measureText(eyebrow).width > maxW && eyebrowSize > 16) {
    eyebrowSize -= 1;
    spacing = Math.max(2, spacing - 0.5);
    ctx.font = font(600, eyebrowSize);
    ctx.letterSpacing = `${spacing}px`;
  }
  eyebrow = ellipsize(ctx, eyebrow, maxW);
  const eyebrowWidth = ctx.measureText(eyebrow).width;
  ctx.restore();

  // name (auto-fit) — measure the real glyph box so tall scripts (e.g. Devanagari) never collide
  let size = 84;
  ctx.font = font(800, size);
  while (ctx.measureText(name).width > maxW && size > 46) {
    size -= 2;
    ctx.font = font(800, size);
  }
  const shownName = ellipsize(ctx, name, maxW);
  const metrics = ctx.measureText(shownName);
  const ascent = Math.max(metrics.actualBoundingBoxAscent || 0, size * 0.7);
  const descent = Math.max(metrics.actualBoundingBoxDescent || 0, size * 0.05);

  const subtitle = drawableName(o.subtitle, '');
  const eyebrowAscent = Math.round(eyebrowSize * 0.75);
  const blockHeight = eyebrowAscent + 20 + ascent + descent + (subtitle ? 38 + 26 : 24) + 46;
  const eyebrowBaseline = Math.round(cy - blockHeight / 2 + eyebrowAscent);
  const nameBaseline = Math.round(eyebrowBaseline + 20 + ascent);
  const subtitleBaseline = Math.round(nameBaseline + descent + 38);

  // draw eyebrow
  ctx.save();
  ctx.font = font(600, eyebrowSize);
  ctx.letterSpacing = `${spacing}px`;
  const eg = ctx.createLinearGradient(tx, 0, tx + eyebrowWidth, 0);
  eg.addColorStop(0, rgba(glow, 1));
  eg.addColorStop(1, '#c4b5fd');
  ctx.fillStyle = eg;
  ctx.fillText(eyebrow, tx, eyebrowBaseline);
  ctx.restore();

  // draw name
  ctx.save();
  ctx.font = font(800, size);
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 24;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(shownName, tx, nameBaseline);
  ctx.restore();

  // draw subtitle
  if (subtitle) {
    ctx.save();
    ctx.font = font(500, 26);
    ctx.fillStyle = 'rgba(226,232,255,0.74)';
    ctx.fillText(ellipsize(ctx, subtitle, maxW), tx, subtitleBaseline);
    ctx.restore();
  }

  // pills
  const pillY = subtitle ? subtitleBaseline + 26 : nameBaseline + descent + 24;
  const pillFill = ctx.createLinearGradient(tx, pillY, tx + 260, pillY + 46);
  pillFill.addColorStop(0, rgba(brand, 0.95));
  pillFill.addColorStop(1, rgba(glow, 0.85));
  const w1 = drawPill(ctx, tx, pillY, `MEMBER #${Number(o.memberCount || 0).toLocaleString('en-US')}`, {
    fill: pillFill,
    color: '#ffffff',
  });
  const handle = `@${drawableName(o.username, 'member')}`;
  drawPill(ctx, tx + w1 + 14, pillY, handle, {
    fill: 'rgba(255,255,255,0.06)',
    stroke: 'rgba(255,255,255,0.20)',
    color: 'rgba(255,255,255,0.88)',
    weight: 600,
    spacing: 0,
  });

  return canvas.encode('png');
}

/** Crops/resizes an uploaded image to the banner size and returns a compact JPEG (for storage). */
async function prepareBackground(buffer) {
  const img = await loadImage(buffer);
  const canvas = createCanvas(W, H);
  drawCover(canvas.getContext('2d'), img, 0, 0, W, H);
  return canvas.encode('jpeg', 88);
}

module.exports = { renderWelcomeCard, prepareBackground, drawableName, CARD_SIZE: { W, H } };
