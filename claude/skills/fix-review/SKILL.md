---
name: fix-review
description: Fleet fix step. Reads review_findings and applies each as a targeted fix. Nothing else — no plan loading, no scope verification, no check output.
---

# Fix Review

Read `$STATE_REVIEW_FINDINGS`. For each finding: make the targeted fix.

- Keep changes minimal — do not touch code unrelated to the finding.
- Do not refactor or clean up while fixing.
- If a finding requires a test change, make it; otherwise do not touch tests.
- Do not re-read the plan or re-verify ticket scope.

Do not commit.

## Done

```bash
touch "$STEP_DONE_FILE"
```

> ⚠️ **This `touch` must be your literal last tool call — actually run it, don't just state that the step is done.** The orchestrator detects completion only when this file appears on disk; a closing summary sentence does not create it. Narrating completion without running the command leaves the step hanging until it is force-nudged.
