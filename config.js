'use strict';
const path = require('node:path');
require('dotenv').config({ quiet: true });

const { parseColor } = require('./lib/color');

/**
 * All runtime settings. Everything can be set with environment variables
 * (Railway → your service → Variables), or a local .env file.
 */
module.exports = {
  token: (process.env.DISCORD_TOKEN || '').trim(),

  /** Optional MongoDB connection string. If empty, data is stored in a JSON file. */
  mongoUri: (process.env.MONGODB_URI || '').trim() || null,
  mongoDb: (process.env.MONGODB_DB || 'aetherbrackets').trim(),

  /**
   * Where the JSON database lives. On Railway, attach a Volume and this is picked up
   * automatically (RAILWAY_VOLUME_MOUNT_PATH), so your data survives redeploys.
   */
  dataDir: path.resolve(
    process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data'),
  ),

  /** If set (Railway/Render/Koyeb do this for web services), a tiny health-check server is started. */
  port: process.env.PORT ? Number(process.env.PORT) : null,

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
