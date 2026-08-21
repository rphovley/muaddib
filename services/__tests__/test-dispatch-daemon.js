#!/usr/bin/env node
"use strict";
// dispatch-daemon.js test suite — resolveRoute label routing logic.
//
// testNoLabels               — no labels → null (skipped)
// testAutoOnly               — auto alone → feature workflow
// testSkipOverridesAuto      — muaddib:skip + auto → null
// testBugLabel               — auto + bug → bug workflow
// testFixLabel               — auto + fix → bug workflow
// testDefectLabel            — auto + defect → bug workflow
// testFastLabel              — auto + fast → feature-fast workflow
// testMuaddibFastLabel       — auto + muaddib:fast → feature-fast workflow
// testPlanOnlyLabel          — auto + plan-only → plan workflow
// testMuaddibPlanLabel       — auto + muaddib:plan → plan workflow
// testBugTakesPrecedence     — auto + bug + fast → bug workflow (bug wins)
// testLabelsCaseInsensitive  — mixed-case label names are normalised
// testThrowsWhenConfigMissing      — getProjectName() with missing .muaddib/manifest.json → clear error, no quotethat fallback
// testThrowsWhenProjectNameMissing — getProjectName() with .muaddib/manifest.json missing "projectName" → clear error
// testInvalidConfigThrowsOnEveryCall — an invalid config throws on every getProjectName() call,
//                                    not just the first (a broken config must never get cached
//                                    as if it were valid)
// testRequireAloneDoesNotThrow     — require() alone (no getProjectName() call) succeeds with no config at all
// testRealStartupFailsCleanlyOnBadConfig — running as the real entry point (require.main===module)
//                                    with bad config fails fast with a clean FATAL log, not an
//                                    uncaught exception from inside an async callback

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { resolveRoute, handleEvent, cleanupWorkerFiles } = require("../dispatch-daemon");
const { writeManifest } = require("./test-utils");

function assertRoute(labels, expectedEntryPoint) {
  const route = resolveRoute(labels);
  if (expectedEntryPoint === null) {
    if (route !== null)
      throw new Error(`expected null, got entryPoint=${route.entryPoint}`);
  } else {
    if (!route)
      throw new Error(
        `expected route with entryPoint=${expectedEntryPoint}, got null`,
      );
    if (route.entryPoint !== expectedEntryPoint) {
      throw new Error(
        `expected entryPoint=${expectedEntryPoint}, got ${route.entryPoint}`,
      );
    }
  }
}

async function testNoLabels() {
  assertRoute([], null);
}

async function testAutoOnly() {
  assertRoute(["auto"], "muaddib.sh");
}

async function testSkipOverridesAuto() {
  assertRoute(["auto", "muaddib:skip"], null);
}

async function testBugLabel() {
  assertRoute(["auto", "bug"], "muaddib.sh");
  const route = resolveRoute(["auto", "bug"]);
  if (!route.workflowFile.endsWith("bug.json"))
    throw new Error(`expected bug.json, got ${route.workflowFile}`);
}

async function testFixLabel() {
  assertRoute(["auto", "fix"], "muaddib.sh");
  const route = resolveRoute(["auto", "fix"]);
  if (!route.workflowFile.endsWith("bug.json"))
    throw new Error(`expected bug.json, got ${route.workflowFile}`);
}

async function testDefectLabel() {
  assertRoute(["auto", "defect"], "muaddib.sh");
  const route = resolveRoute(["auto", "defect"]);
  if (!route.workflowFile.endsWith("bug.json"))
    throw new Error(`expected bug.json, got ${route.workflowFile}`);
}

async function testFastLabel() {
  assertRoute(["auto", "fast"], "muaddib-fast.sh");
  const route = resolveRoute(["auto", "fast"]);
  if (!route.workflowFile.endsWith("feature-fast.json"))
    throw new Error(`expected feature-fast.json, got ${route.workflowFile}`);
}

async function testMuaddibFastLabel() {
  assertRoute(["auto", "muaddib:fast"], "muaddib-fast.sh");
}

async function testPlanOnlyLabel() {
  assertRoute(["auto", "plan-only"], "muaddib-plan.sh");
  const route = resolveRoute(["auto", "plan-only"]);
  if (!route.workflowFile.endsWith("plan.json"))
    throw new Error(`expected plan.json, got ${route.workflowFile}`);
}

async function testMuaddibPlanLabel() {
  assertRoute(["auto", "muaddib:plan"], "muaddib-plan.sh");
}

async function testBugTakesPrecedence() {
  // bug check comes before fast check in resolveRoute
  assertRoute(["auto", "bug", "fast"], "muaddib.sh");
  const route = resolveRoute(["auto", "bug", "fast"]);
  if (!route.workflowFile.endsWith("bug.json"))
    throw new Error(
      `expected bug.json (bug before fast), got ${route.workflowFile}`,
    );
}

async function testLabelsCaseInsensitive() {
  // handleEvent lowercases labels before calling resolveRoute.
  // resolveRoute itself is case-sensitive: 'Bug' misses the bug branch and falls
  // through to the default feature workflow instead of routing as a bug.
  assertRoute(["auto", "Bug"], "muaddib.sh"); // falls through to feature, not bug
  const bugRoute = resolveRoute(["auto", "Bug"]);
  if (!bugRoute.workflowFile.endsWith("feature.json")) {
    throw new Error(
      `expected feature.json for un-lowercased 'Bug', got ${bugRoute.workflowFile}`,
    );
  }
  assertRoute(["auto", "bug"], "muaddib.sh"); // matches bug branch
  const normalRoute = resolveRoute(["auto", "bug"]);
  if (!normalRoute.workflowFile.endsWith("bug.json")) {
    throw new Error(
      `expected bug.json for lowercased 'bug', got ${normalRoute.workflowFile}`,
    );
  }
}

// ─── handleEvent: real webhook body fixtures ─────────────────────────────────

// Real webhook body captured from Linear when 'auto' label was applied to QUO-333.
const REAL_UPDATE_BODY = Buffer.from(
  JSON.stringify({
    action: "update",
    type: "Issue",
    data: {
      id: "72a00800-74f7-4536-b688-38da6c50bca2",
      identifier: "QUO-333",
      labelIds: ["c328c424-c60e-4c60-8f64-2ba5282e6090"],
      labels: [
        {
          id: "c328c424-c60e-4c60-8f64-2ba5282e6090",
          color: "#4cb782",
          name: "auto",
        },
      ],
    },
    updatedFrom: { labelIds: [], updatedAt: "2026-06-07T05:16:55.658Z" },
  }),
);

async function testRealWebhookAutoLabel() {
  // Captures the bug: Linear sends data.labels as a flat array, not {nodes:[...]}.
  // handleEvent must route this to the feature workflow, not skip it.
  let dispatched = null;
  // Monkey-patch isDispatched/markDispatched/countActiveWorkers/trySpawn via
  // the module's exported handleEvent — we verify via the log output instead.
  const lines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => {
    lines.push(s);
    return true;
  };
  try {
    await handleEvent(REAL_UPDATE_BODY);
  } finally {
    process.stdout.write = origWrite;
  }
  const logged = lines.join("");
  // Should NOT log "no route matched"
  if (logged.includes("no route matched")) {
    throw new Error(
      `label extraction failed — got "no route matched": ${logged}`,
    );
  }
  // Should NOT log "update without label change" or "labels unchanged"
  if (
    logged.includes("update without label change") ||
    logged.includes("labels unchanged")
  ) {
    throw new Error(`label-change detection failed: ${logged}`);
  }
}

async function testRealWebhookNoLabels() {
  // Webhook update where labels array is empty — should be skipped.
  const body = Buffer.from(
    JSON.stringify({
      action: "update",
      type: "Issue",
      data: {
        identifier: "QUO-334",
        labelIds: [],
        labels: [],
      },
      updatedFrom: {
        labelIds: ["c328c424-c60e-4c60-8f64-2ba5282e6090"],
        updatedAt: "2026-06-07T00:00:00.000Z",
      },
    }),
  );
  const lines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => {
    lines.push(s);
    return true;
  };
  try {
    await handleEvent(body);
  } finally {
    process.stdout.write = origWrite;
  }
  const logged = lines.join("");
  if (!logged.includes("no route matched")) {
    throw new Error(
      `expected "no route matched" for empty labels, got: ${logged}`,
    );
  }
}

// ─── handleEvent: DISPATCH_ASSIGNEE_ID filtering ─────────────────────────────

const ASSIGNED_BODY = Buffer.from(
  JSON.stringify({
    action: "update",
    type: "Issue",
    data: {
      identifier: "QUO-400",
      labelIds: ["c328c424-c60e-4c60-8f64-2ba5282e6090"],
      labels: [
        {
          id: "c328c424-c60e-4c60-8f64-2ba5282e6090",
          color: "#4cb782",
          name: "auto",
        },
      ],
      assignee: { id: "user-aaa", name: "Alice" },
    },
    updatedFrom: { labelIds: [], updatedAt: "2026-06-07T06:00:00.000Z" },
  }),
);

const UNASSIGNED_BODY = Buffer.from(
  JSON.stringify({
    action: "update",
    type: "Issue",
    data: {
      identifier: "QUO-401",
      labelIds: ["c328c424-c60e-4c60-8f64-2ba5282e6090"],
      labels: [
        {
          id: "c328c424-c60e-4c60-8f64-2ba5282e6090",
          color: "#4cb782",
          name: "auto",
        },
      ],
    },
    updatedFrom: { labelIds: [], updatedAt: "2026-06-07T06:00:00.000Z" },
  }),
);

async function captureLog(fn) {
  const lines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => {
    lines.push(s);
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = origWrite;
  }
  return lines.join("");
}

async function testAssigneeFilterMatchingUser() {
  process.env.DISPATCH_ASSIGNEE_ID = "user-aaa";
  try {
    const logged = await captureLog(() => handleEvent(ASSIGNED_BODY));
    if (logged.includes("≠ DISPATCH_ASSIGNEE_ID")) {
      throw new Error(
        `expected ticket to pass assignee filter, got: ${logged}`,
      );
    }
  } finally {
    delete process.env.DISPATCH_ASSIGNEE_ID;
  }
}

async function testAssigneeFilterWrongUser() {
  process.env.DISPATCH_ASSIGNEE_ID = "user-bbb";
  try {
    const logged = await captureLog(() => handleEvent(ASSIGNED_BODY));
    if (!logged.includes("≠ DISPATCH_ASSIGNEE_ID")) {
      throw new Error(`expected assignee mismatch skip, got: ${logged}`);
    }
    if (!logged.includes("QUO-400")) {
      throw new Error(`expected identifier in log, got: ${logged}`);
    }
  } finally {
    delete process.env.DISPATCH_ASSIGNEE_ID;
  }
}

async function testAssigneeFilterUnassignedTicket() {
  process.env.DISPATCH_ASSIGNEE_ID = "user-aaa";
  try {
    const logged = await captureLog(() => handleEvent(UNASSIGNED_BODY));
    if (!logged.includes("≠ DISPATCH_ASSIGNEE_ID")) {
      throw new Error(
        `expected unassigned ticket to be skipped, got: ${logged}`,
      );
    }
  } finally {
    delete process.env.DISPATCH_ASSIGNEE_ID;
  }
}

async function testAssigneeFilterNotSet() {
  delete process.env.DISPATCH_ASSIGNEE_ID;
  const logged = await captureLog(() => handleEvent(ASSIGNED_BODY));
  if (logged.includes("≠ DISPATCH_ASSIGNEE_ID")) {
    throw new Error(
      `expected no assignee filter when env var unset, got: ${logged}`,
    );
  }
}

// ─── cleanupWorkerFiles ───────────────────────────────────────────────────────

async function testCleanupDeletesDoneOrphan() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "muaddib-test-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "worker-1.state"), "DONE");
    fs.writeFileSync(path.join(tmpDir, "worker-1.events"), "{}");
    fs.writeFileSync(path.join(tmpDir, "worker-1-branch.log"), "branch");
    fs.mkdirSync(path.join(tmpDir, ".skills-1"));

    cleanupWorkerFiles(tmpDir, new Set());

    if (fs.existsSync(path.join(tmpDir, "worker-1.state")))
      throw new Error("worker-1.state should have been deleted");
    if (fs.existsSync(path.join(tmpDir, "worker-1.events")))
      throw new Error("worker-1.events should have been deleted");
    if (fs.existsSync(path.join(tmpDir, "worker-1-branch.log")))
      throw new Error("worker-1-branch.log should have been deleted");
    if (fs.existsSync(path.join(tmpDir, ".skills-1")))
      throw new Error(".skills-1 should have been deleted");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testCleanupMovesFailedOrphan() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "muaddib-test-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "worker-2.state"), "FAILED");
    fs.writeFileSync(path.join(tmpDir, "worker-2.events"), "{}");
    fs.writeFileSync(path.join(tmpDir, "worker-2-branch.log"), "branch");

    cleanupWorkerFiles(tmpDir, new Set());

    if (fs.existsSync(path.join(tmpDir, "worker-2.state")))
      throw new Error("worker-2.state should have been moved out");
    const failedDir = path.join(tmpDir, "failed");
    if (!fs.existsSync(failedDir))
      throw new Error("failed/ directory was not created");
    const workerDirs = fs.readdirSync(failedDir).filter((e) =>
      e.startsWith("worker-2-"),
    );
    if (workerDirs.length === 0)
      throw new Error("no failed/worker-2-* directory created");
    const dest = path.join(failedDir, workerDirs[0]);
    if (!fs.existsSync(path.join(dest, "worker-2.state")))
      throw new Error("worker-2.state not found in failed dir");
    if (!fs.existsSync(path.join(dest, "worker-2.events")))
      throw new Error("worker-2.events not found in failed dir");
    if (!fs.existsSync(path.join(dest, "worker-2-branch.log")))
      throw new Error("worker-2-branch.log not found in failed dir");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testCleanupSkipsActiveWorker() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "muaddib-test-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "worker-3.state"), "DONE");
    fs.writeFileSync(path.join(tmpDir, "worker-3.events"), "{}");

    cleanupWorkerFiles(tmpDir, new Set([3]));

    if (!fs.existsSync(path.join(tmpDir, "worker-3.state")))
      throw new Error("worker-3.state should have been preserved (active)");
    if (!fs.existsSync(path.join(tmpDir, "worker-3.events")))
      throw new Error("worker-3.events should have been preserved (active)");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testCleanupNoStateFile() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "muaddib-test-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "worker-4.events"), "{}");
    fs.writeFileSync(path.join(tmpDir, "worker-4-branch.log"), "branch");

    cleanupWorkerFiles(tmpDir, new Set());

    if (fs.existsSync(path.join(tmpDir, "worker-4.events")))
      throw new Error("worker-4.events should have been deleted");
    if (fs.existsSync(path.join(tmpDir, "worker-4-branch.log")))
      throw new Error("worker-4-branch.log should have been deleted");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── config validation (lazy) ─────────────────────────────────────────────────
// dispatch-daemon.js reads .muaddib/manifest.json lazily — only when something
// actually needs the project name (getProjectName()), not merely on require().
// That's deliberate: it keeps the module importable in isolation (as this
// whole test file already does at the top, without a REPO_ROOT override —
// harmless precisely because plain require() never touches config) without
// every unrelated test needing a valid config. So these two tests call
// getProjectName() explicitly, in a subprocess so the thrown error doesn't take
// this whole test process down.

const DISPATCH_DAEMON_PATH = path.join(__dirname, "../dispatch-daemon.js");

function callGetProjectNameInSubprocess(repoRoot) {
  return spawnSync(
    process.execPath,
    ["-e", `require(${JSON.stringify(DISPATCH_DAEMON_PATH)}).getProjectName()`],
    { encoding: "utf8", env: { ...process.env, REPO_ROOT: repoRoot } },
  );
}

async function testThrowsWhenConfigMissing() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "muaddib-test-"));
  try {
    const r = callGetProjectNameInSubprocess(tmpDir);
    if (r.status === 0) throw new Error("expected non-zero exit when .muaddib/manifest.json is missing — got a silent quotethat-shaped default instead");
    if (!r.stderr.includes("manifest.json")) throw new Error(`error should name the missing file, got: ${r.stderr}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testThrowsWhenProjectNameMissing() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "muaddib-test-"));
  try {
    writeManifest(tmpDir, JSON.stringify({}));
    const r = callGetProjectNameInSubprocess(tmpDir);
    if (r.status === 0) throw new Error('expected non-zero exit when "projectName" is missing — got a silent "quotethat" default instead');
    if (!r.stderr.includes("projectName")) throw new Error(`error should mention projectName, got: ${r.stderr}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Regression test: getConfig() used to cache the parsed config BEFORE
// validating "projectName", so an invalid config threw only on the first
// call — every later call silently returned the invalid (projectName:
// undefined) config instead of throwing again. Only masked in production
// because main()'s sole caller exits the process on the first failure; any
// other caller (a retry, a longer-lived reuse of the module) would have hit
// the silent-undefined path. Calls getProjectName() twice in one process and
// asserts both throw.
async function testInvalidConfigThrowsOnEveryCall() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "muaddib-test-"));
  try {
    writeManifest(tmpDir, JSON.stringify({}));
    const r = spawnSync(
      process.execPath,
      ["-e", `
        const { getProjectName } = require(${JSON.stringify(DISPATCH_DAEMON_PATH)});
        let firstThrew = false, secondThrew = false, secondValue;
        try { getProjectName(); } catch (_) { firstThrew = true; }
        try { secondValue = getProjectName(); } catch (_) { secondThrew = true; }
        console.log(JSON.stringify({ firstThrew, secondThrew, secondValue }));
      `],
      { encoding: "utf8", env: { ...process.env, REPO_ROOT: tmpDir } },
    );
    if (r.status !== 0) throw new Error(`subprocess itself failed: ${r.stderr}`);
    const result = JSON.parse(r.stdout);
    if (!result.firstThrew) throw new Error("expected the first call to throw");
    if (!result.secondThrew) {
      throw new Error(`expected the second call to also throw, but it returned projectName=${JSON.stringify(result.secondValue)} silently`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testRequireAloneDoesNotThrow() {
  // The point of laziness: importing the module (without calling
  // getProjectName()) must succeed even with no .muaddib/manifest.json at all —
  // otherwise every test/tool that only needs resolveRoute/handleEvent would
  // be forced to supply a valid config just to require() this file.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "muaddib-test-"));
  try {
    const r = spawnSync(
      process.execPath,
      ["-e", `require(${JSON.stringify(DISPATCH_DAEMON_PATH)}); console.log("ok")`],
      { encoding: "utf8", env: { ...process.env, REPO_ROOT: tmpDir } },
    );
    if (r.status !== 0) throw new Error(`expected require() alone to succeed with no .muaddib/manifest.json, got exit ${r.status}: ${r.stderr}`);
    if (!r.stdout.includes("ok")) throw new Error(`expected "ok" on stdout, got: ${r.stdout}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Regression test: getConfig()/getProjectName() are lazy so require() alone
// is safe (see testRequireAloneDoesNotThrow above) — but a lazy throw from
// inside an async callback (e.g. execFile's callback in
// getActiveWorkerProjects()) would be UNCAUGHT there, crashing the process
// ungracefully well after startup instead of failing fast and cleanly. The
// fix: main() forces getConfig() synchronously, before anything async
// starts, so by the time any callback could call it, it's already cached
// and can't throw. Runs the daemon as the real entry point (require.main
// === module), not via require() — that's the only path that exercises this.
async function testRealStartupFailsCleanlyOnBadConfig() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "muaddib-test-"));
  try {
    const r = spawnSync(
      process.execPath,
      [DISPATCH_DAEMON_PATH],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          REPO_ROOT: tmpDir,
          LINEAR_API_KEY: "test-key",
          LINEAR_TEAM_ID: "test-team",
          DISPATCH_PORT: "0",
        },
      },
    );
    if (r.status === 0) throw new Error("expected the daemon to exit non-zero on missing config, got exit 0 (still running / hung?)");
    if (r.signal) throw new Error(`daemon was killed by signal ${r.signal} — likely hung instead of failing fast (timeout=${r.error && r.error.code === "ETIMEDOUT"})`);
    if (!r.stdout.includes("FATAL") && !r.stderr.includes("FATAL")) {
      throw new Error(`expected a clean "FATAL: ..." startup error, got stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
    }
    // Must not show a raw uncaught-exception stack trace — that's exactly
    // the ungraceful crash this test guards against.
    if (r.stderr.includes("Uncaught") || r.stderr.includes("uncaughtException")) {
      throw new Error(`daemon crashed with an uncaught exception instead of failing cleanly: ${r.stderr}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── runner ──────────────────────────────────────────────────────────────────

async function main() {
  const tests = [
    ["resolveRoute: no labels → null", testNoLabels],
    ["resolveRoute: auto only → feature workflow", testAutoOnly],
    ["resolveRoute: muaddib:skip + auto → null", testSkipOverridesAuto],
    ["resolveRoute: auto + bug → bug workflow", testBugLabel],
    ["resolveRoute: auto + fix → bug workflow", testFixLabel],
    ["resolveRoute: auto + defect → bug workflow", testDefectLabel],
    ["resolveRoute: auto + fast → feature-fast workflow", testFastLabel],
    [
      "resolveRoute: auto + muaddib:fast → feature-fast workflow",
      testMuaddibFastLabel,
    ],
    ["resolveRoute: auto + plan-only → plan workflow", testPlanOnlyLabel],
    ["resolveRoute: auto + muaddib:plan → plan workflow", testMuaddibPlanLabel],
    ["resolveRoute: bug takes precedence over fast", testBugTakesPrecedence],
    [
      "resolveRoute: labels must be pre-lowercased (case-sensitive match)",
      testLabelsCaseInsensitive,
    ],
    [
      "handleEvent: real webhook flat labels array → routes correctly",
      testRealWebhookAutoLabel,
    ],
    [
      "handleEvent: real webhook empty labels after change → no route matched",
      testRealWebhookNoLabels,
    ],
    [
      "handleEvent: assignee filter — matching user proceeds",
      testAssigneeFilterMatchingUser,
    ],
    [
      "handleEvent: assignee filter — wrong user skipped",
      testAssigneeFilterWrongUser,
    ],
    [
      "handleEvent: assignee filter — unassigned ticket skipped",
      testAssigneeFilterUnassignedTicket,
    ],
    [
      "handleEvent: assignee filter — unset env dispatches any ticket",
      testAssigneeFilterNotSet,
    ],
    [
      "cleanupWorkerFiles: deletes all files for orphan with DONE state",
      testCleanupDeletesDoneOrphan,
    ],
    [
      "cleanupWorkerFiles: moves files to failed/ for FAILED orphan",
      testCleanupMovesFailedOrphan,
    ],
    [
      "cleanupWorkerFiles: skips files for active worker",
      testCleanupSkipsActiveWorker,
    ],
    [
      "cleanupWorkerFiles: deletes files when state file is missing",
      testCleanupNoStateFile,
    ],
    [
      "config: missing .muaddib/manifest.json throws a clear error (no quotethat fallback)",
      testThrowsWhenConfigMissing,
    ],
    [
      "config: missing projectName throws a clear error (no quotethat fallback)",
      testThrowsWhenProjectNameMissing,
    ],
    [
      "config: invalid config throws on every call, not just the first",
      testInvalidConfigThrowsOnEveryCall,
    ],
    [
      "config: require() alone does not throw even with no config (lazy)",
      testRequireAloneDoesNotThrow,
    ],
    [
      "config: real startup (require.main) fails cleanly on bad config, not an uncaught exception",
      testRealStartupFailsCleanlyOnBadConfig,
    ],
  ];

  let passed = 0;
  for (const [name, fn] of tests) {
    process.stdout.write(`  ${name}... `);
    try {
      await fn();
      process.stdout.write("PASS\n");
      passed++;
    } catch (err) {
      process.stdout.write(`FAIL\n    ${err.message}\n`);
    }
  }

  console.log(`\n${passed}/${tests.length} passed`);
  if (passed < tests.length) process.exit(1);
}

main().catch((err) => {
  console.error("FAIL —", err.message);
  process.exit(1);
});
