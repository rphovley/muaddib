'use strict';
// Reads and parses a project's .muaddib/manifest.json — shared by
// start-servers.js and dispatch-daemon.js so the two can't drift on error
// wording/behavior for the same two universal failure modes (missing file,
// invalid JSON). No fallback: every muaddib service needs project-supplied
// config, not a guessed default. Callers validate their own required fields
// on top of this.

const fs = require('fs');
const path = require('path');

function readMuaddibConfig(repoDir) {
  const configPath = path.join(repoDir, '.muaddib', 'manifest.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    throw new Error(`missing ${configPath} — no built-in project config`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in ${configPath}: ${err.message}`);
  }
}

module.exports = { readMuaddibConfig };
