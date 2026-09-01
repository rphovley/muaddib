---
name: fix-checks
description: Fleet fix step. Reads check_output and fixes the specific failing tests/checks shown. Nothing else — no plan loading, no scope verification, no new features.
---

# Fix Checks

Read `$STATE_CHECK_OUTPUT`. It contains labeled sections of raw compiler/test failure output, e.g.:

```
=== api:check ===
src/foo.ts(12,3): error TS2345: ...
```

Fix only what is shown. Make the minimum changes needed to clear the failures:

- If a test is asserting the wrong thing, fix the test.
- If application code has a type error or runtime bug, fix the code.
- Do not touch anything not referenced in the output.
- Do not re-read the plan, re-verify ticket scope, or add new features.

Do not commit.

## Done

```bash
touch "$STEP_DONE_FILE"
```

> ⚠️ **This `touch` must be your literal last tool call — actually run it, don't just state that the step is done.** The orchestrator detects completion only when this file appears on disk; a closing summary sentence does not create it. Narrating completion without running the command leaves the step hanging until it is force-nudged.
