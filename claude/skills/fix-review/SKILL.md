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
