'use strict';
const assert = require('node:assert/strict');
const { ComponentType, MessageFlags } = require('discord.js');


function toJSON(c) {
  return typeof c.toJSON === 'function' ? c.toJSON() : c;
}

function validatePayload(name, payload, { ephemeralOk = true } = {}) {
  const comps = payload.components.map(toJSON);
  let count = 0;
  let text = 0;
  const refs = new Set();
  const walk = (c, parent) => {
    count++;
    assert.ok(typeof c.type === 'number', `${name}: component without type`);
    if (c.custom_id) assert.ok(c.custom_id.length <= 100, `${name}: custom_id too long (${c.custom_id})`);
    switch (c.type) {
      case ComponentType.TextDisplay:
        assert.ok(c.content && c.content.length, `${name}: empty text display`);
        text += c.content.length;
        break;
      case ComponentType.Section: {
        const n = c.components.length;
        assert.ok(n >= 1 && n <= 3, `${name}: section must have 1-3 text displays (has ${n})`);
        assert.ok(c.accessory, `${name}: section needs an accessory`);
        break;
      }
      case ComponentType.ActionRow: {
        const buttons = c.components.filter((x) => x.type === ComponentType.Button).length;
        const selects = c.components.length - buttons;
        assert.ok((buttons >= 1 && buttons <= 5 && selects === 0) || (selects === 1 && buttons === 0), `${name}: invalid action row`);
        break;
      }
      case ComponentType.Button:
        if (c.label) assert.ok(c.label.length <= 80, `${name}: button label too long`);
        assert.ok(c.label || c.emoji, `${name}: button needs label or emoji`);
        if (c.style === 5) assert.ok(c.url, `${name}: link button needs url`);
        else assert.ok(c.custom_id, `${name}: button needs custom_id`);
        break;
      case ComponentType.StringSelect:
        assert.ok(c.options.length >= 1 && c.options.length <= 25, `${name}: select options 1-25`);
        assert.ok(c.max_values <= c.options.length, `${name}: max_values > options`);
        for (const o of c.options) assert.ok(o.label.length <= 100 && o.value.length <= 100, `${name}: option too long`);
        break;
      case ComponentType.MediaGallery:
        assert.ok(c.items.length >= 1 && c.items.length <= 10, `${name}: gallery needs 1-10 items`);
        for (const i of c.items) if (i.media.url.startsWith('attachment://')) refs.add(i.media.url.slice(13));
        break;
      case ComponentType.File:
        assert.ok(c.file.url.startsWith('attachment://'), `${name}: file component must use attachment://`);
        refs.add(c.file.url.slice(13));
        break;
      case ComponentType.Thumbnail:
        if (c.media.url.startsWith('attachment://')) refs.add(c.media.url.slice(13));
        break;
      case ComponentType.Container:
        assert.ok(parent === null, `${name}: containers can't be nested`);
        break;
      default:
    }
    for (const child of c.components ?? []) walk(child, c);
    if (c.accessory) walk(c.accessory, c);
  };
  for (const c of comps) walk(c, null);
  assert.ok(count <= 40, `${name}: ${count} components (max 40)`);
  assert.ok(text <= 4000, `${name}: ${text} text characters (max 4000)`);
  assert.ok(payload.flags & MessageFlags.IsComponentsV2, `${name}: missing IsComponentsV2 flag`);
  if (!ephemeralOk) assert.ok(!(payload.flags & MessageFlags.Ephemeral), `${name}: should not be ephemeral`);
  const fileNames = new Set((payload.files ?? []).map((f) => f.name));
  for (const r of refs) assert.ok(fileNames.has(r), `${name}: attachment://${r} has no matching file`);
  for (const f of fileNames) assert.ok(refs.has(f), `${name}: file ${f} is uploaded but never shown`);
  return { count, text };
}


module.exports = { validatePayload, toJSON };
