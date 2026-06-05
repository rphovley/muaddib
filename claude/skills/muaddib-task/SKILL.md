---
name: muaddib-task
description: Fleet-safe free-form task executor. Takes a task description and implements it end-to-end without a Linear ticket — reads CLAUDE.md, explores codebase, plans inline, implements, runs /check, commits, and opens a PR. Never calls AskUserQuestion.
---

# Muaddib Task (Free-form)

Fleet-safe, no Linear ticket required. Takes a task description from `$ARGUMENTS` and implements it end-to-end. **Never calls `AskUserQuestion`.** When a decision is ambiguous, make the most reasonable interpretation and document it in the PR body.

Programmatic. **Auto-commits and opens a PR** — this is the documented exception to the user's usual "I handle my own commits" rule, scoped to fleet workers only.

## Step 1 — Understand the task

Read the task from `$ARGUMENTS`. Then:

1. Read the root `CLAUDE.md` and any project-specific `CLAUDE.md` in the area the task touches.
2. Identify which project(s) under `projects/*` are affected.
3. If the task spans more than one directory or the affected area is unclear, spawn the `Explore` agent to locate the relevant files — do not grep the world inline.

## Step 2 — Plan (inline)

Produce a short plan without posting it anywhere:

- **Diagnosis** — what exactly needs to change and why
- **Files to touch** — concrete paths or globs
- **Work streams** — ordered list if there are dependencies, unordered if parallel
- **Test strategy** — what to write and how to verify
- **Acceptance criteria** — bulleted list of what "done" looks like

If the task is genuinely ambiguous in a way that would block safe implementation, write `BLOCKED` to the state file and stop:

```bash
printf 'BLOCKED %s\n' "$(date -u +%FT%TZ)" > "/var/run/agent-status/worker-${WORKER_INDEX}.state" 2>/dev/null || true
```

Otherwise proceed — document any interpretation choices in the PR body under "Decisions".

## Step 3 — Branch from `main`

```bash
git checkout main
git pull
git checkout -b task/<short-slug>
```

`<short-slug>` is 3–5 kebab-case words drawn from the task description. Example: `task/fix-auth-token-expiry`. If `WORKER_INDEX` is set, prefix with the worker number: `task/w<N>-fix-auth-token-expiry`.

If the working tree has uncommitted changes, stop and write `BLOCKED` to the state file — do not stash or discard.

## Step 4 — Implement

Work the plan's work streams in dependency order. For each:

1. Read neighboring files in the affected directory to match existing patterns.
2. Make the changes.
3. Write tests inline — do not defer tests to a later step.

Test conventions:
- API service edits → unit tests
- API database edits → integration tests
- Portal logic → component or hook regression tests
- Use `npm run test:unit` / `npm run test:integration`, not raw `vitest`.

Do not expand scope beyond the plan. If a discovery mid-implementation reveals the plan is wrong, write `BLOCKED` to the state file and stop — do not silently pivot.

## Step 5 — Run `/check`

Call `Skill(check)` with no `args`.

## Step 6 — Fix findings, then re-check

Triage output:

- **Blockers + majors** — fix every one.
- **Questions** — decide and act. Do not leave open.
- **Minors + nits** — fix if cheap; otherwise note in the PR body under "Review notes — deferred".

Re-run `Skill(check)`. Loop until clean **or** until **3 fix passes have run** — then write `FAILED` and stop:

```bash
printf 'FAILED %s\n' "$(date -u +%FT%TZ)" > "/var/run/agent-status/worker-${WORKER_INDEX}.state" 2>/dev/null || true
```

Do not commit, push, or open a PR on failure. If `WORKER_INDEX` is unset (non-fleet context), the write silently fails — that is expected.

## Step 7 — Commit

```bash
git add <specific files>
git commit -m "<imperative summary>

<one-paragraph body describing what changed and why>

Co-Authored-By: Claude <noreply@anthropic.com>"
```

Stage files by name — never `git add -A` / `git add .`.

If a pre-commit hook fails, fix the underlying issue and create a **new** commit. Never `--amend` or `--no-verify`.

## Step 8 — Push and open PR

```bash
git push -u origin <branch>
gh pr create --base main --title "<short title>" --body "$(cat <<'EOF'
## Summary
- <1–3 bullets>

## Task
<verbatim task description from $ARGUMENTS>

## Decisions
<any interpretation choices made in Step 2, or "None">

## Test plan
- [ ] ...

## Review notes
<any deferred /check findings, or "None">

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

PR title ≤ 70 characters. Detail belongs in the body.

Print the PR URL as the final line of output.
