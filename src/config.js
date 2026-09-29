'use strict';
const path = require('node:path');
require('dotenv').config({ quiet: true });

const { parseColor } = require('./lib/color');

/** The first of these environment variables that has a value → { name, value }. */
function firstEnv(...names) {
  for (const name of names) {
    const value = (process.env[name] || '').trim();
    if (value) return { name, value };
  }
  return null;
}

/**
 * MongoDB connection string. On Railway: add a MongoDB database and set
 * MONGODB_URI=${{MongoDB.MONGO_URL}} on the bot service (a reference named MONGO_URL works too).
 */
const mongo = firstEnv('MONGODB_URI', 'MONGO_URL');

/**
 * All runtime settings. Everything can be set with environment variables
 * (Railway → your service → Variables), or a local .env file.
 */
module.exports = {
  token: (process.env.DISCORD_TOKEN || '').trim(),

  /** Optional MongoDB connection string. If empty, data is stored in a JSON file. */
  mongoUri: mongo?.value ?? null,
  /** Which variable the connection string came from (for error messages). */
  mongoUriVar: mongo?.name ?? 'MONGODB_URI',
  mongoDb: (process.env.MONGODB_DB || 'aetherbrackets').trim(),

  /** Railway sets these automatically — used to warn when data would not survive a redeploy. */
  onRailway: Boolean(process.env.RAILWAY_ENVIRONMENT_ID || process.env.RAILWAY_PROJECT_ID),
  persistentDisk: Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR),

  /**
   * Where the JSON database lives. On Railway, attach a Volume and this is picked up
   * automatically (RAILWAY_VOLUME_MOUNT_PATH), so your data survives redeploys.
   */
  dataDir: path.resolve(
    process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data'),
  ),

  /** If set (Railway/Render/Koyeb do this for web services), a tiny health-check server is started. */
  port: process.env.PORT ? Number(process.env.PORT) : null,

  /**
   * How parts 2+ of a long announcement show the ping (every part is mentioned, so all parts stay highlighted):
   * "tag" (default) = small "↳ Part 2 of 3 · @everyone" line · "hidden" = same line, ping behind a tiny spoiler ·
   * "full" = the same ping line above every part.
   */
  extraPingStyle: ['tag', 'hidden', 'full'].includes((process.env.EXTRA_PING_STYLE || '').trim().toLowerCase())
    ? process.env.EXTRA_PING_STYLE.trim().toLowerCase()
    : 'tag',

  /** Text shown under the bot's name ("Watching ..."). */
  status: process.env.STATUS_TEXT || 'AetherBrackets',

  brand: {
    name: process.env.BRAND_NAME || 'AetherBrackets',
    /** Main accent colour used for cards/containers. */
    color: parseColor(process.env.BRAND_COLOR) ?? 0x7c5cff,
    /** Secondary glow colour used on the welcome banner. */
    glow: parseColor(process.env.BRAND_COLOR_2) ?? 0x22d3ee,
  },

  colors: {
    success: 0x22c55e,
    danger: 0xef4444,
    warning: 0xf59e0b,
    info: 0x5b8cff,
  },
};
