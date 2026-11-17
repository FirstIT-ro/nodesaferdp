'use strict';
// Plain stdout logging; under systemd this lands in the journal.
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}
module.exports = log;
