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

/** A storage problem the server owner has to fix (shown in the logs in plain words). */
class StorageError extends Error {}

const CONNECT_ATTEMPTS = Math.max(1, Number(process.env.MONGODB_CONNECT_ATTEMPTS) || 8);
const RETRY_SAVE_MS = 10_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "mongodb://user:secret@host:27017/db?x" → "host:27017" (never log passwords). */
function mongoHost(uri) {
  return /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/i.exec(uri)?.[1] ?? 'unknown host';
}

/** Errors that retrying won't fix. */
function isPermanent(err) {
  return err?.name === 'MongoParseError' || err?.name === 'MongoAPIError' || err?.code === 18 || /auth(entication)? failed/i.test(err?.message ?? '');
}

function explainMongoError(err, host, varName) {
  const msg = err?.message ?? String(err);
  if (err?.code === 18 || /auth(entication)? failed/i.test(msg)) {
    return `MongoDB at ${host} rejected the username/password. Set ${varName} to the reference \${{MongoDB.MONGO_URL}} instead of copying the URL by hand.`;
  }
  if (err?.name === 'MongoParseError') return `${varName} is not a valid MongoDB connection string (${msg}).`;
  return (
    `Could not reach MongoDB at ${host} (${msg}). Check that the MongoDB service is running in the same Railway project ` +
    `and that ${varName} is \${{MongoDB.MONGO_URL}} (the name before the dot must match the database service's name).`
  );
}

class MongoDriver {
  constructor(uri, dbName, varName) {
    this.uri = uri;
    this.dbName = dbName;
    this.varName = varName;
    this.host = mongoHost(uri);
  }

  async load() {
    if (/\$\{\{/.test(this.uri)) {
      throw new StorageError(
        `${this.varName} is "${this.uri}" — a Railway reference that was not filled in. The name before the dot must match your database service's name exactly (usually \${{MongoDB.MONGO_URL}}).`,
      );
    }
    if (!/^mongodb(\+srv)?:\/\//i.test(this.uri)) {
      throw new StorageError(`${this.varName} must start with mongodb:// or mongodb+srv:// — on Railway, set it to \${{MongoDB.MONGO_URL}}.`);
    }
    log.info(`Storage: MongoDB at ${this.host} — connecting…`);
    const { MongoClient } = require('mongodb');
    for (let attempt = 1; ; attempt++) {
      const client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 10_000, appName: 'aetherbrackets-bot' });
      try {
        await client.connect();
        await client.db(this.dbName).command({ ping: 1 });
        this.client = client;
        break;
      } catch (err) {
        await client.close().catch(() => {});
        if (isPermanent(err) || attempt >= CONNECT_ATTEMPTS) throw new StorageError(explainMongoError(err, this.host, this.varName));
        // the database may still be starting (e.g. first deploy on Railway) — wait and try again
        const wait = Math.min(5 * attempt, 20);
        log.warn(`MongoDB at ${this.host} is not reachable yet (attempt ${attempt}/${CONNECT_ATTEMPTS}): ${err.message} — retrying in ${wait}s…`);
        await sleep(wait * 1000);
      }
    }
    this.col = this.client.db(this.dbName).collection('guilds');
    const docs = await this.col.find({}).toArray();
    return Object.fromEntries(docs.map(({ _id, ...rest }) => [_id, rest]));
  }

  async saveGuilds(entries) {
    await Promise.all(
      entries
        .filter(([, data]) => data)
        // JSON round-trip = exactly what the JSON file would store (no undefined, no class instances)
        .map(([id, data]) => this.col.replaceOne({ _id: id }, JSON.parse(JSON.stringify(data)), { upsert: true })),
    );
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
      this.driver = new MongoDriver(config.mongoUri, config.mongoDb, config.mongoUriVar);
    } else {
      this.driver = new JsonDriver(config.dataDir);
      log.info(`Storage: JSON file in ${config.dataDir}`);
      if (config.onRailway && !config.persistentDisk) {
        log.warn(
          '⚠️  No database connected: settings are saved inside the container and will be LOST on the next deploy. ' +
            'Add a MongoDB database in Railway and set MONGODB_URI to ${{MongoDB.MONGO_URL}} on this service (see docs/1-setup-guide.md).',
        );
      }
    }
    const loaded = await this.driver.load();
    for (const [id, data] of Object.entries(loaded)) this.guilds[id] = withDefaults(data);
    if (this.driver instanceof MongoDriver) {
      log.info(`Storage: MongoDB connected ✓ (database "${config.mongoDb}", ${Object.keys(loaded).length} server(s) loaded)`);
    }
  },

  /** Returns (and creates if needed) the live config object for a guild. Mutate it, then call save(). */
  guild(guildId) {
    if (!this.guilds[guildId]) this.guilds[guildId] = defaultGuild();
    return this.guilds[guildId];
  },

  save(guildId) {
    this.dirty.add(guildId);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush().catch(() => {}), 400);
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
      })
      .catch((err) => {
        // keep the changes in memory and try again, so a short database outage loses nothing
        for (const id of ids) this.dirty.add(id);
        log.error(`Save failed (${err.message}) — retrying in ${RETRY_SAVE_MS / 1000}s.`);
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush().catch(() => {}), RETRY_SAVE_MS);
        throw err;
      });
    return this.writing;
  },

  async close() {
    await this.flush().catch(() => log.error('Final save failed — the last few changes may not have been stored.'));
    clearTimeout(this.timer);
    if (this.driver?.close) await this.driver.close();
  },

  StorageError,
  defaults: { DEFAULT_WELCOME_MESSAGE, defaultGuild },
};

module.exports = store;
