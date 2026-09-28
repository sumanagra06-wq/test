'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const config = require('../config');
const log = require('./log');

/**
 * Tiny persistence layer. Everything is kept in memory and written back on change.
 *  - Default: a JSON file in DATA_DIR (attach a Railway Volume so it survives redeploys)
 *  - Optional: MongoDB (set MONGODB_URI) — works on any host, no volume needed
 */

const DEFAULT_WELCOME_MESSAGE = [
  'Hey {user}, great to have you here! 🎉',
  'You’re our **{members_ordinal}** member.',
  '',
  '📜 Read the rules, 🎭 grab your roles and get ready for the next bracket.',
].join('\n');

function defaultGuild() {
  return {
    welcome: {
      enabled: false,
      channelId: null,
      title: '👋 Welcome to {server}!',
      message: DEFAULT_WELCOME_MESSAGE,
      imageSubtitle: 'Your bracket journey starts now',
      image: true,
      background: null, // base64 JPEG (custom banner background)
      color: null,
      ping: true,
      rulesChannelId: null,
      rolesChannelId: null,
      autoRoleId: null,
    },
    /** messageId → { channelId, mode, panel?: {title, description, color}, entries: [{key, emoji, roleId, description}] } */
    reactionRoles: {},
    /** panelId → button-role panel */
    buttonPanels: {},
    /** first messageId → announcement record (used for editing) */
    announcements: {},
  };
}

function withDefaults(data) {
  const d = defaultGuild();
  const g = data && typeof data === 'object' ? data : {};
  return {
    ...d,
    ...g,
    welcome: { ...d.welcome, ...(g.welcome || {}) },
    reactionRoles: g.reactionRoles || {},
    buttonPanels: g.buttonPanels || {},
    announcements: g.announcements || {},
  };
}

class JsonDriver {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'aetherbrackets-db.json');
  }

  async load() {
    await fsp.mkdir(this.dir, { recursive: true });
    for (const file of [this.file, `${this.file}.bak`]) {
      try {
        const raw = await fsp.readFile(file, 'utf8');
        const parsed = JSON.parse(raw);
        if (file !== this.file) log.warn('Main database file was unreadable — restored from backup.');
        return parsed.guilds || {};
      } catch (err) {
        if (err.code !== 'ENOENT') log.error(`Could not read ${file}:`, err.message);
      }
    }
    return {};
  }

  async save(guilds) {
    const json = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), guilds });
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, json);
    if (fs.existsSync(this.file)) await fsp.copyFile(this.file, `${this.file}.bak`).catch(() => {});
    await fsp.rename(tmp, this.file);
  }
}

class MongoDriver {
  constructor(uri, dbName) {
    this.uri = uri;
    this.dbName = dbName;
  }

  async load() {
    const { MongoClient } = require('mongodb');
    this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 15_000 });
    await this.client.connect();
    this.col = this.client.db(this.dbName).collection('guilds');
    const docs = await this.col.find({}).toArray();
    return Object.fromEntries(docs.map(({ _id, ...rest }) => [_id, rest]));
  }

  async saveGuilds(entries) {
    await Promise.all(entries.map(([id, data]) => this.col.replaceOne({ _id: id }, data, { upsert: true })));
  }

  async close() {
    await this.client?.close().catch(() => {});
  }
}

const store = {
  guilds: {},
  driver: null,
  dirty: new Set(),
  timer: null,
  writing: Promise.resolve(),

  async init() {
    if (config.mongoUri) {
      this.driver = new MongoDriver(config.mongoUri, config.mongoDb);
      log.info('Storage: MongoDB');
    } else {
      this.driver = new JsonDriver(config.dataDir);
      log.info(`Storage: JSON file in ${config.dataDir}`);
    }
    const loaded = await this.driver.load();
    for (const [id, data] of Object.entries(loaded)) this.guilds[id] = withDefaults(data);
  },

  /** Returns (and creates if needed) the live config object for a guild. Mutate it, then call save(). */
  guild(guildId) {
    if (!this.guilds[guildId]) this.guilds[guildId] = defaultGuild();
    return this.guilds[guildId];
  },

  save(guildId) {
    this.dirty.add(guildId);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush().catch((e) => log.error('Save failed:', e)), 400);
  },

  flush() {
    clearTimeout(this.timer);
    const ids = [...this.dirty];
    this.dirty.clear();
    if (!ids.length) return this.writing;
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        if (this.driver instanceof MongoDriver) {
          await this.driver.saveGuilds(ids.map((id) => [id, this.guilds[id]]));
        } else {
          await this.driver.save(this.guilds);
        }
      });
    return this.writing;
  },

  async close() {
    await this.flush().catch((e) => log.error('Final save failed:', e));
    if (this.driver?.close) await this.driver.close();
  },

  defaults: { DEFAULT_WELCOME_MESSAGE, defaultGuild },
};

module.exports = store;
