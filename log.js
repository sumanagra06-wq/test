'use strict';

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

module.exports = {
  info: (...args) => console.log(`[${stamp()}] INFO `, ...args),
  warn: (...args) => console.warn(`[${stamp()}] WARN `, ...args),
  error: (...args) => console.error(`[${stamp()}] ERROR`, ...args),
};
