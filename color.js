'use strict';

/** Friendly colour names admins can type instead of hex codes. */
const NAMED_COLORS = {
  purple: 0x7c5cff,
  violet: 0x8b5cf6,
  blurple: 0x5865f2,
  blue: 0x3b82f6,
  sky: 0x38bdf8,
  cyan: 0x22d3ee,
  teal: 0x14b8a6,
  green: 0x22c55e,
  lime: 0x84cc16,
  yellow: 0xfacc15,
  gold: 0xf5b301,
  orange: 0xf97316,
  red: 0xef4444,
  crimson: 0xdc143c,
  pink: 0xec4899,
  magenta: 0xd946ef,
  white: 0xf5f5f5,
  grey: 0x9ca3af,
  gray: 0x9ca3af,
  black: 0x111111,
};

/**
 * Parses "#7C5CFF", "7c5cff", "0x7C5CFF", "#abc" or a colour name.
 * @returns {number|null} integer colour, or null if empty/invalid
 */
function parseColor(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number' && Number.isFinite(input)) return input & 0xffffff;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;
  if (Object.hasOwn(NAMED_COLORS, s)) return NAMED_COLORS[s];
  const m = s.match(/^(?:#|0x)?([0-9a-f]{6}|[0-9a-f]{3})$/);
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
  return parseInt(hex, 16);
}

/** True when the admin asked for the default/brand colour. */
function isDefaultColorKeyword(input) {
  return /^(brand|default|reset|none)$/i.test(String(input || '').trim());
}

function toHex(color) {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0').toUpperCase()}`;
}

/** Converts an int colour to an rgba() string for canvas drawing. */
function rgba(color, alpha = 1) {
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

module.exports = { NAMED_COLORS, parseColor, isDefaultColorKeyword, toHex, rgba };
