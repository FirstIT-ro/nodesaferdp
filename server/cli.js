#!/usr/bin/env node
'use strict';
// User management for NodeSafeRDP.
//   node cli.js add <user>       create user (prompts for password)
//   node cli.js passwd <user>    change password (also logs the user out everywhere)
//   node cli.js del <user>       delete user (sessions end within a minute)
//   node cli.js list             list users
// On an installed server use the wrapper: sudo nodesaferdp-user <command> ...
const readline = require('readline');
const { loadConfig } = require('./src/config');
const { readUsers, writeUsers, hashPassword, validUsername } = require('./src/auth');

function ask(prompt, hidden) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = s => { if (s.includes(prompt)) process.stdout.write(prompt); };
    }
    rl.question(prompt, a => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); });
  });
}

async function readPassword() {
  if (process.env.NSR_PASSWORD) return process.env.NSR_PASSWORD; // for automation
  const a = await ask('Password (min 10 chars): ', true);
  const b = await ask('Repeat password: ', true);
  if (a !== b) throw new Error('Passwords do not match');
  return a;
}

async function main() {
  const [cmd, user] = process.argv.slice(2);
  const cfg = loadConfig();
  const users = readUsers(cfg);
  switch (cmd) {
    case 'add':
    case 'passwd': {
      if (!validUsername(user)) throw new Error('Username: 1-64 chars of A-Z a-z 0-9 . _ @ -');
      if (cmd === 'add' && users[user]) throw new Error(`User ${user} already exists (use passwd)`);
      if (cmd === 'passwd' && !users[user]) throw new Error(`No such user ${user}`);
      const pw = await readPassword();
      if (pw.length < 10) throw new Error('Password must be at least 10 characters');
      // pwChanged invalidates every session created before it (the server checks this)
      users[user] = { ...(await hashPassword(pw)), created: users[user]?.created || new Date().toISOString(), pwChanged: Date.now() };
      writeUsers(cfg, users);
      console.log(cmd === 'add' ? `User ${user} created.` : `Password for ${user} changed.`);
      break;
    }
    case 'del':
      if (!users[user]) throw new Error(`No such user ${user}`);
      delete users[user];
      writeUsers(cfg, users);
      console.log(`User ${user} deleted.`);
      break;
    case 'list':
      for (const [u, r] of Object.entries(users)) console.log(`${u}\tcreated ${r.created || '?'}`);
      break;
    default:
      console.log('Usage: cli.js add <user> | passwd <user> | del <user> | list');
      process.exit(2);
  }
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
