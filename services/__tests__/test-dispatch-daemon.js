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

const { resolveRoute, handleEvent } = require("../dispatch-daemon");

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
