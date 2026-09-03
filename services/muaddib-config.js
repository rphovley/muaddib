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

// Valid Conductor autonomy levels. validate-manifest.js's exported
// VALID_AUTONOMY_LEVELS is the documented source of truth; this inline copy
// keeps muaddib-config.js dependency-free (validate-manifest already requires
// this module, so requiring it back would create a cycle). Keep the two in sync.
const VALID_AUTONOMY_LEVELS = ['L0', 'L1', 'L2', 'L3'];

// Resolve a project's Conductor autonomy level from .muaddib/manifest.json.
// Absent key defaults to "L0" (report-only), matching read-config.sh and the
// validator, so existing manifests are unchanged. A present-but-invalid value
// throws — the same fail-loud contract read-config.sh gives bash callers, so a
// typo never silently downgrades (or escalates) the Conductor's authority.
function readAutonomyLevel(repoDir) {
  const config = readMuaddibConfig(repoDir);
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(
      `manifest is not a JSON object: ${path.join(repoDir, '.muaddib', 'manifest.json')}`
    );
  }
  const level = config.autonomyLevel == null ? 'L0' : config.autonomyLevel;
  if (!VALID_AUTONOMY_LEVELS.includes(level)) {
    throw new Error(
      `invalid "autonomyLevel": ${JSON.stringify(config.autonomyLevel)} in ${path.join(repoDir, '.muaddib', 'manifest.json')} (must be one of: ${VALID_AUTONOMY_LEVELS.join(', ')})`
    );
  }
  return level;
}

module.exports = { readMuaddibConfig, readAutonomyLevel, VALID_AUTONOMY_LEVELS };
