'use strict';
const fs = require('fs');
const path = require('path');

// Configuration is read from a JSON file. Nothing secret lives in the repo:
// the installer generates /etc/nodesaferdp/config.json on the server.
function loadConfig() {
  const file = process.env.NSR_CONFIG || path.join(__dirname, '..', 'config.json');
  let raw = {};
  if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, 'utf8'));

  const cfg = {
    file,
    listenHost: raw.listenHost || '127.0.0.1',
    port: Number(raw.port || 8080),
    dataDir: raw.dataDir || path.join(__dirname, '..', 'data'),
    agentKey: raw.agentKey || process.env.NSR_AGENT_KEY || '',
    sessionHours: Number(raw.sessionHours || 12),
    // true when running behind nginx on the same host (reads X-Real-IP)
    trustProxy: raw.trustProxy !== false,
    // false only for local development over plain http
    secureCookies: raw.secureCookies !== false,
  };
  if (!cfg.agentKey || cfg.agentKey.length < 24) {
    throw new Error(`agentKey missing or shorter than 24 chars (config: ${file})`);
  }
  fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
  return cfg;
}

module.exports = { loadConfig };
