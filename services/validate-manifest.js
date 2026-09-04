'use strict';
// Consolidated .muaddib/manifest.json validator — the single "is this manifest
// well-formed?" answer the onboarding wizard runs at the end.
//
// Before this, the required-field / port / ticketSource checks lived ad-hoc,
// each enforcing its own slice at its own call site:
//   - bin/read-config.sh   — projectName, ticketSource ∈ {linear,github},
//                            github owner/repo, workerPorts.{api,db,sketch}
//   - services/muaddib-config.js — parse only (missing file / bad JSON)
//   - services/start-servers.js  — projects[] non-empty
//   - services/goals.js          — retryThreshold is a non-negative integer
// There was no one place that could tell the wizard "this manifest will spawn a
// worker cleanly" without actually spawning one. This module is that place.
//
// VALID_TICKET_SOURCES mirrors read-config.sh's case exactly: "linear" | "github".
// "raw" is deliberately NOT a manifest value — it's a dispatch-time override
// (muaddib.sh --raw / TICKET_SOURCE=raw) synthesized from task text, never
// declared in a committed manifest. A manifest carrying "raw" is a mistake, so
// it's rejected here the same way read-config.sh rejects it.
//
// validateManifest(config, opts) is pure and total: it never throws and never
// touches the filesystem, returning { ok, errors, warnings }. validateManifestFile()
// layers the file read (via readMuaddibConfig) on top so the pure core stays
// unit-testable with plain objects.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readMuaddibConfig } = require('./muaddib-config');
// Import the constants from the dependency-free ./context-source/sources module
// rather than ./context-source itself, so validation doesn't load the whole
// registry (ticket-source clients, goals, decision-log) just for two constants.
const { CONTEXT_SOURCE_SOURCES, VALID_CONTEXT_SOURCE_TYPES } = require('./context-source/sources');

const VALID_TICKET_SOURCES = ['linear', 'github'];
const PORT_ROLES = ['api', 'db', 'sketch'];

// Worker N binds `base + N` for N in 1..MUADDIB_MAX_WORKERS (bin/worker-alloc.sh
// defaults MUADDIB_MAX_WORKERS to 64), so each workerPorts base actually reserves
// the whole span [base+1, base+WORKER_PORT_SPAN], not just the base itself.
const WORKER_PORT_SPAN = 64;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

// A port is valid iff it's an integer in the TCP range. workerPorts bases and
// dispatchPort both go through this.
function isValidPort(v) {
  return Number.isInteger(v) && v > 0 && v < 65536;
}

// Detect base-port / dispatchPort clashes between this manifest and other
// projects on the same host. Worker ports are `base + workerIndex`, so two
// projects sharing a base for the same role (or sharing a dispatchPort) will
// collide once both spawn a worker 0. Returned as warnings, not errors: another
// project's manifest could have changed since, and onboarding shouldn't hard-fail
// on state it doesn't own — it flags the overlap for the operator to resolve.
// `otherProjects` entries: { projectName, dispatchPort, workerPorts }.
//
// Worker bases and the dispatchPort all live in one host port namespace, so a
// collision isn't limited to same-role or dispatch-vs-dispatch: my worker base
// can land on their dispatchPort, or on a different role's base. Compare every
// one of this manifest's ports against every one of theirs.
function portList(cfg) {
  const ports = [];
  for (const role of PORT_ROLES) {
    const p = cfg.workerPorts && cfg.workerPorts[role];
    if (isValidPort(p)) ports.push([`workerPorts.${role}`, p]);
  }
  if (isValidPort(cfg.dispatchPort)) ports.push(['dispatchPort', cfg.dispatchPort]);
  return ports;
}

function detectPortCollisions(config, otherProjects) {
  const warnings = [];
  const self = config.projectName;
  const mine = portList(config);
  for (const other of otherProjects || []) {
    if (!other || other.projectName === self) continue;
    const theirs = portList(other);
    for (const [myLabel, myPort] of mine) {
      for (const [theirLabel, theirPort] of theirs) {
        if (myPort === theirPort) {
          warnings.push(
            `${myLabel} (${myPort}) collides with project "${other.projectName}" ${theirLabel} — pick a non-overlapping range`
          );
        }
      }
    }
  }
  return warnings;
}

// Validate a parsed manifest object. opts.otherProjects (optional) enables the
// cross-project port-collision scan. Never throws.
function validateManifest(config, opts = {}) {
  const errors = [];
  const warnings = [];

  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return { ok: false, errors: ['manifest is not a JSON object'], warnings };
  }

  // projectName — required (read-config.sh fails loud without it).
  if (!isNonEmptyString(config.projectName)) {
    errors.push('missing "projectName"');
  }

  // ticketSource — defaults to "linear" when absent (matches read-config.sh's
  // `// "linear"`), otherwise must be one of the committed backends.
  const ticketSource = config.ticketSource == null ? 'linear' : config.ticketSource;
  if (!VALID_TICKET_SOURCES.includes(ticketSource)) {
    errors.push(
      `invalid "ticketSource": ${JSON.stringify(config.ticketSource)} (must be "linear" or "github"; "raw" is a dispatch-time override, not a manifest value)`
    );
  }
  // GitHub backend requires owner + repo (read-config.sh enforces both).
  if (ticketSource === 'github') {
    if (!isNonEmptyString(config.githubOwner)) {
      errors.push('"ticketSource":"github" requires "githubOwner"');
    }
    if (!isNonEmptyString(config.githubRepo)) {
      errors.push('"ticketSource":"github" requires "githubRepo"');
    }
  }

  // workerPorts — no baked default anywhere (spawn-worker.sh errors at spawn
  // time via muaddib_worker_port), so require all three bases here.
  const wp = config.workerPorts;
  if (wp === null || typeof wp !== 'object' || Array.isArray(wp)) {
    errors.push('missing "workerPorts" ({ api, db, sketch })');
  } else {
    for (const role of PORT_ROLES) {
      if (!isValidPort(wp[role])) {
        errors.push(`"workerPorts.${role}" must be a TCP port (1-65535), got ${JSON.stringify(wp[role])}`);
      }
    }
  }

  // dispatchPort — used by the dispatch daemon. Missing is a warning (a project
  // that only ever spawns manually never needs it); a present-but-bogus value
  // is an error.
  if (config.dispatchPort == null) {
    warnings.push('no "dispatchPort" — required to run the dispatch daemon (`npm run muaddib:start`)');
  } else if (!isValidPort(config.dispatchPort)) {
    errors.push(`"dispatchPort" must be a TCP port (1-65535), got ${JSON.stringify(config.dispatchPort)}`);
  }

  // All bases + dispatchPort must be distinct within this one manifest, or a
  // single worker's own three tunnels (plus the daemon) would fight over a port.
  const localPorts = [];
  if (wp && typeof wp === 'object') {
    for (const role of PORT_ROLES) {
      if (isValidPort(wp[role])) localPorts.push([`workerPorts.${role}`, wp[role]]);
    }
  }
  if (isValidPort(config.dispatchPort)) localPorts.push(['dispatchPort', config.dispatchPort]);
  const seen = new Map();
  for (const [label, port] of localPorts) {
    if (seen.has(port)) {
      errors.push(`${label} (${port}) duplicates ${seen.get(port)} — every port in a manifest must be distinct`);
    } else {
      seen.set(port, label);
    }
  }

  // Exact equality isn't enough: each workerPorts base reserves [base+1,
  // base+WORKER_PORT_SPAN], so two bases only WORKER_PORT_SPAN apart, or a
  // dispatchPort sitting inside a worker range, collide at a nonzero worker index
  // even though the bases themselves differ.
  const workerBases = [];
  if (wp && typeof wp === 'object') {
    for (const role of PORT_ROLES) {
      if (isValidPort(wp[role])) workerBases.push([`workerPorts.${role}`, wp[role]]);
    }
  }
  for (let i = 0; i < workerBases.length; i++) {
    for (let j = i + 1; j < workerBases.length; j++) {
      const [aLabel, a] = workerBases[i];
      const [bLabel, b] = workerBases[j];
      const gap = Math.abs(a - b);
      if (gap !== 0 && gap <= WORKER_PORT_SPAN) {
        errors.push(
          `${aLabel} (${a}) and ${bLabel} (${b}) are only ${gap} apart — worker ranges span ${WORKER_PORT_SPAN} ports (base+1..base+${WORKER_PORT_SPAN}) and would overlap; separate the bases by more than ${WORKER_PORT_SPAN}`
        );
      }
    }
    if (isValidPort(config.dispatchPort)) {
      const [label, base] = workerBases[i];
      if (config.dispatchPort > base && config.dispatchPort <= base + WORKER_PORT_SPAN) {
        errors.push(
          `dispatchPort (${config.dispatchPort}) falls inside ${label}'s worker range (${base + 1}..${base + WORKER_PORT_SPAN}) — a worker at index ${config.dispatchPort - base} would bind it`
        );
      }
    }
  }

  // projects[] — start-servers.js and dispatch-daemon.js both need at least one.
  if (!Array.isArray(config.projects) || config.projects.length === 0) {
    errors.push('missing "projects" — needs at least one { name, path, checkCommand }');
  } else {
    config.projects.forEach((p, i) => {
      const at = `projects[${i}]`;
      if (p === null || typeof p !== 'object' || Array.isArray(p)) {
        errors.push(`${at} is not an object`);
        return;
      }
      if (!isNonEmptyString(p.name)) errors.push(`${at} missing "name"`);
      if (!isNonEmptyString(p.path)) errors.push(`${at} missing "path"`);
      // checkCommand isn't strictly required by any reader, but a project with
      // none can't be verified by the fleet's /check loop — worth flagging.
      if (!isNonEmptyString(p.checkCommand)) {
        warnings.push(`${at} ("${p.name || '?'}") has no "checkCommand" — the fleet can't run checks for it`);
      }
    });
  }

  // retryThreshold — goals.js falls back to 3 for anything non-integer, so a
  // bad value silently loses the operator's intent: warn.
  if (config.retryThreshold != null && !(Number.isInteger(config.retryThreshold) && config.retryThreshold >= 0)) {
    warnings.push(`"retryThreshold" should be a non-negative integer, got ${JSON.stringify(config.retryThreshold)} (falling back to 3)`);
  }

  // contextSources — optional. When present, an array of { type, source } pairs
  // the fleet pulls context from before planning/implementing (see
  // services/context-source). Each entry's `type` must be a known context-source
  // type and its `source` must be one the registry can resolve for that type —
  // the same "must be a known backend" contract ticketSource enforces above.
  // Mirrors the registry's own errors so a bad manifest fails the same way a
  // bad getContextSource() call would.
  if (config.contextSources != null) {
    if (!Array.isArray(config.contextSources)) {
      errors.push(
        `"contextSources" must be an array of { type, source }, got ${JSON.stringify(config.contextSources)}`
      );
    } else {
      config.contextSources.forEach((entry, i) => {
        const at = `contextSources[${i}]`;
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          errors.push(`${at} is not an object ({ type, source })`);
          return;
        }
        const validSources = CONTEXT_SOURCE_SOURCES[entry.type];
        if (!validSources) {
          errors.push(
            `${at} invalid "type": ${JSON.stringify(entry.type)} (must be one of: ${VALID_CONTEXT_SOURCE_TYPES.join(', ')})`
          );
          return;
        }
        // `source` defaults to "builtin" when omitted, matching getContextSource.
        const source = entry.source == null ? 'builtin' : entry.source;
        if (!validSources.includes(source)) {
          errors.push(
            `${at} invalid "source": ${JSON.stringify(entry.source)} for type "${entry.type}" (must be one of: ${validSources.join(', ')})`
          );
        }
      });
    }
  }

  for (const w of detectPortCollisions(config, opts.otherProjects)) warnings.push(w);

  return { ok: errors.length === 0, errors, warnings };
}

// Read repoDir/.muaddib/manifest.json and validate it. A missing file or invalid
// JSON surfaces as a single error (readMuaddibConfig throws a file-naming error;
// we convert it rather than letting it propagate, so callers get the same
// { ok, errors, warnings } shape either way).
function validateManifestFile(repoDir, opts = {}) {
  let config;
  try {
    config = readMuaddibConfig(repoDir);
  } catch (err) {
    return { ok: false, errors: [err.message], warnings: [] };
  }
  return validateManifest(config, opts);
}

module.exports = {
  validateManifest,
  validateManifestFile,
  detectPortCollisions,
  VALID_TICKET_SOURCES,
  VALID_CONTEXT_SOURCE_TYPES,
};

// Gather the { projectName, dispatchPort, workerPorts } of every OTHER onboarded
// project so the CLI can run the cross-project collision scan (otherwise
// detectPortCollisions never fires outside unit tests). Sources, all best-effort
// and never throwing: MUADDIB_OTHER_MANIFESTS (colon-separated repo dirs or
// manifest.json paths) plus any ~/.muaddib/<project>/manifest.json copies.
function collectOtherProjects(selfRepoDir) {
  const found = [];
  const seenPaths = new Set();
  const selfManifest = path.resolve(selfRepoDir, '.muaddib', 'manifest.json');

  const add = (manifestPath) => {
    const resolved = path.resolve(manifestPath);
    if (resolved === selfManifest || seenPaths.has(resolved)) return;
    seenPaths.add(resolved);
    try {
      const cfg = JSON.parse(fs.readFileSync(resolved, 'utf8'));
      if (cfg && typeof cfg === 'object') {
        found.push({
          projectName: cfg.projectName,
          dispatchPort: cfg.dispatchPort,
          workerPorts: cfg.workerPorts,
        });
      }
    } catch (_) {
      // Missing / unreadable / bad JSON — skip; collision scanning is advisory.
    }
  };

  for (const entry of (process.env.MUADDIB_OTHER_MANIFESTS || '').split(':')) {
    const e = entry.trim();
    if (!e) continue;
    add(e.endsWith('.json') ? e : path.join(e, '.muaddib', 'manifest.json'));
  }

  try {
    const root = path.join(os.homedir(), '.muaddib');
    for (const name of fs.readdirSync(root)) {
      add(path.join(root, name, 'manifest.json'));
    }
  } catch (_) {
    // No ~/.muaddib account dirs — nothing to compare against.
  }

  return found;
}

// CLI: `node services/validate-manifest.js [repoDir]`. Prints ✓/⚠/✗ lines and
// exits 1 if there are errors (0 if only warnings, so it's safe in a check loop
// that treats warnings as advisory).
if (require.main === module) {
  const repoDir = process.argv[2] || process.env.REPO_ROOT || process.cwd();
  const { ok, errors, warnings } = validateManifestFile(repoDir, {
    otherProjects: collectOtherProjects(repoDir),
  });
  const file = path.join(repoDir, '.muaddib', 'manifest.json');
  for (const e of errors) process.stdout.write(`  ✗ ${e}\n`);
  for (const w of warnings) process.stdout.write(`  ⚠ ${w}\n`);
  if (ok) {
    process.stdout.write(`  ✓ ${file} is valid${warnings.length ? ` (${warnings.length} warning(s))` : ''}\n`);
  } else {
    process.stdout.write(`\n${errors.length} error(s) in ${file}\n`);
    process.exit(1);
  }
}
