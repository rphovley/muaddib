# muaddib

Isolated, parallel Claude Code workers. Each worker is a sandboxed Docker
container running an **interactive** Claude session, on its
own git branch, with its own throwaway Postgres. You stay in the loop for the
genuinely-interactive moments (`/grill-me`, permission prompts); a status board
tells you which worker needs you.

## Why it's built this way

- **Containerized for blast radius.** All-commands-on damage is contained to the
  container (inside Docker Desktop's Linux VM), never your Mac — provided we
  don't hand the container the keys to the host. So: **no docker.sock mount**,
  **no host bind-mounts** except two narrow, intentional ones (`status/` rw,
  your `~/.claude/skills` ro), non-root user, and CPU/mem/pids caps.
- **Local dev secrets, prod unreachable by construction.** App secrets come from
  a local `.muaddib/secrets.env` (dev/local values only) loaded straight into the
  container — no secret-manager indirection. For a project whose compose overlay
  defines a DB contract (quotethat's does — see "Project compose overlay"), the
  overlay's `environment:` block force-overrides `PG_*` / `DATABASE_URL` to the
  local sidecar, so a worker can't connect to a cloud/prod database even if a
  prod URL were dropped into the env file by mistake.
- **Easy to make interactive** When building with LLMs, often you need to come in and
  make adjustments. This setup makes it easy to let the LLMs run uninterrupted
  or jump in when needed for guidance

## `.muaddib/` project directory

The `.muaddib/` directory at the repo root is the single place for
project-owned muaddib config and setup. muaddib itself owns nothing
project-specific — all customisation lives here.

**Onboarding a new project?** Run `./muaddib-onboard.sh [repo]` — an interactive
wizard that inspects the target repo, asks only the decisions a human must make,
generates the artifacts it needs (hooks, compose overlay, worker-safe check
command, PR-template override), writes `.muaddib/manifest.json` +
`.muaddib/secrets.env`, and validates the result. The full categorized checklist
it implements lives in [`.muaddib/onboarding.md`](.muaddib/onboarding.md).

| Path | Purpose |
|------|---------|
| `.muaddib/manifest.json` | The project registry — dev/check/lint/test scripts, ports, seed command, default model, `workerPorts`, etc. Every config-reading script/service in this repo reads this file; no fallback if it's missing. Validated by `services/validate-manifest.js`. |
| `.muaddib/onboarding.md` | The onboarding checklist + design doc — what a project needs and how the `onboard-project` wizard handles each item. Committed. |
| `.muaddib/goals.md` | Goal Context — durable, cross-ticket fleet policy. Committed, not gitignored. Bootstrapped with a default template on first read if missing. See "Goal Context" below. |
| `.muaddib/decisions.jsonl` | Decision Log — append-only, ticket-scoped audit trail of Conductor Handoff Records, one JSON object per line. Committed, not gitignored. See "Decision Log" below. |
| `.muaddib/secrets.env.example` | Committed template for the secrets bundle (gitignored: `.muaddib/secrets.env`) |
| `.muaddib/secrets.env` | Your filled-in secrets (gitignored). Copy from `secrets.env.example`. |
| `.muaddib/hooks/on-worker-start.sh` | Project hook run by the worker entrypoint after env is loaded. Executable; receives the full worker env. |
| `.muaddib/hooks/sizing.js` | The well-known sizing hook `orchestrator/sizing-signal.js#findSizingHook` discovers (`node sizing.js <ticketId>` → Sizing Signal JSON on stdout). muaddib's own is **active** — it sizes muaddib's tickets for real via a ConductorSession over the ticket + gathered context (~90s/ticket, once per ticket), so the `size-and-schedule.js` split path (muaddib#106/#107) runs against a genuine signal. It also doubles as the reference other projects copy to their own `.muaddib/hooks/sizing.js`; a project shipping no hook stays `{ configured: false }` (a first-class non-error state). |
| `.muaddib/docker/docker-compose.worker.yml` | Project compose overlay — services/env the generic `docker-compose.worker.yml` doesn't carry (e.g. a DB sidecar). Layered in via an extra `-f` when present. |
| `~/.muaddib/<project>/workers/.worker-N.env` | Per-worker ephemeral env file. Written by `spawn-worker.sh` **outside the repo tree** (it carries the subscription + GitHub tokens); regenerated every spawn, never edit by hand. |
| `~/.muaddib/<project>/dispatch.json`, `dispatch-queue.json` | Dispatch daemon's dedup ledger + pending-spawn queue, kept outside the repo tree. In the dispatch container these persist via a host bind-mount (`MUADDIB_DISPATCH_DIR`). |
| `~/.muaddib/<project>/session/session.json` | Session Context — live, **ephemeral** working state for a single Conductor run, kept outside the repo tree so it can never be committed. Thrown away at run end, never accumulates. See "Session Context" below. |
| `.muaddib/plan.md` | Current implementation plan written by the muaddib fleet agent. Not tracked by git. |
| `.muaddib/pr-template.md` | Optional PR-body override. When present, `commit-and-pr` / `muaddib-task` use it verbatim (with `$VAR`/`${VAR}` interpolation) as the GitHub PR body instead of muaddib's generic source-neutral default. Not required. Copy `claude/skills/commit-and-pr/pr-template.example.md` as a starting point. See "PR body template" below. |

### PR body template (`.muaddib/pr-template.md`)

By default `commit-and-pr` and `muaddib-task` open PRs with a generic,
source-neutral body (Summary / Ticket / Test plan / Review notes — plus Task /
Decisions for free-form tasks). This default is deliberately project-agnostic:
it carries no `## Preview` or `## Preview credentials` sections and no `## Linear`
header, so muaddib's own self-hosting PRs stay clean.

A project can override the entire body by committing `.muaddib/pr-template.md`.
When that file exists it becomes the PR body verbatim, with these variables
interpolated (`$VAR` or `${VAR}`). Interpolation is deliberately narrow: a
reference to a **known** variable is substituted (the preview URLs/credentials
fall back to `(unavailable)`), an **unknown** `$VAR` is left untouched (so prose
like a `$5` price survives), `$$` renders a literal `$`, and a single leading
HTML comment is stripped (so the example file's usage note never ships):

| Variable | Meaning |
|----------|---------|
| `$STATE_TICKET_URL` | Ticket URL — source-neutral (Linear, GitHub, or `(none)` for a raw/free-form task). |
| `$STATE_API_TUNNEL_URL` | Preview API tunnel URL. |
| `$STATE_PORTAL_URL` | Preview Portal URL. |
| `$STATE_PORTAL_PREVIEW_URL` | Preview Portal URL with `?is_preview=true` appended — or `(unavailable)` (never a bare `(unavailable)?is_preview=true`). |
| `$STATE_HOMEOWNER_URL` | Preview Homeowner URL. |
| `$PREVIEW_EMAIL` / `$PREVIEW_PASSWORD` | Preview login for the seeded contractor. |
| `$HO_MAGIC_LINK` | Homeowner magic-link path (appended to the homeowner URL). |
| `$HO_CREDENTIAL` | Pre-rendered homeowner login line (URL + magic-link), or `(unavailable)`. |
| `$PR_SUMMARY` | Agent-authored Summary bullets. |
| `$PR_TEST_PLAN` | Agent-authored Test plan. |
| `$PR_REVIEW_NOTES` | Agent-authored deferred-findings notes, or `None`. |
| `$PR_TASK` / `$PR_DECISIONS` | Free-form task description / interpretation choices (`muaddib-task` only). |

`claude/skills/commit-and-pr/pr-template.example.md` reproduces quotethat's
original Preview / Preview-credentials sections — copy it to your project's
`.muaddib/pr-template.md` and edit. muaddib itself ships no override.

### Hook contract

`worker-entrypoint.sh` does exactly two things for project setup:

1. Sources `.muaddib/secrets.env` verbatim into the worker environment.
2. If `.muaddib/hooks/on-worker-start.sh` exists and is executable, runs it with `bash`.

The hook receives the full worker env (all vars from `secrets.env` plus dynamic
values like `WORKER_INDEX`, `BRANCH`, `REPO_URL`). Use it for anything that must
happen on every worker start — materialising secret files, writing config, etc.

### Project compose overlay

`muaddib/docker-compose.worker.yml` carries no project-specific services or env
vars — no DB sidecars, no app config contract, just the generic sandbox (build,
the worker container, its narrow host mounts, resource limits). A project that
needs more than that (a database, app-specific env vars, etc.) supplies its own
overlay at `.muaddib/docker/docker-compose.worker.yml`. When present,
`spawn-worker.sh` and `teardown-worker.sh` pass it as an additional `-f` after
the base file, so Compose merges it in (new services are added; `worker`'s
`environment`/`depends_on` are merged in on top). Both scripts must agree on
which `-f` flags were used for a given worker, or `teardown-worker.sh` won't
know about (and won't tear down) the overlay's services — they derive the list
the same way via `read-config.sh`'s `MUADDIB_COMPOSE_OVERLAY`.

quotethat's own DB contract (Postgres dev + test sidecars, `PG_*`/`DATABASE_URL`/
`TEST_DB_*`/`ENV` env vars) lives at `.muaddib/docker/docker-compose.worker.yml`
in the quotethat repo as a worked example of this pattern.

## Port scheme

Worker `N` (1-based) gets `<base> + N` for each port, where the bases come from
`.muaddib/manifest.json`'s `workerPorts` (`api`, `db`, `sketch`) — there's no default
baked into `spawn-worker.sh`, so a project must supply a range that doesn't
collide with whatever else is running on the host:

```json
"workerPorts": { "api": 8089, "db": 5442, "sketch": 4386 }
```

quotethat supplies exactly these values, giving:

| Service             | Host port  | Worker 1 | Worker 2 |
| ------------------- | ---------- | -------- | -------- |
| API (`npm run dev`) | `8089 + N` | 8090     | 8091     |
| Postgres (dev)¹     | `5442 + N` | 5443     | 5444     |
| Postgres (test)¹    | not published — internal `db_test:5432` |
| Sketch (UI/UX prototyping loop) | `4386 + N` | 4387 | 4388 |

Compose project is namespaced `quotethat-w<N>`, so containers/volumes never
collide across workers.

¹ Postgres sidecars aren't part of the generic `docker-compose.worker.yml` —
they come from quotethat's DB compose overlay (see "Project compose overlay").
A project without a DB overlay has no `db`/`db_test` services at all.

## Ticket source config

Which ticket backend a project uses is declared in `.muaddib/manifest.json`,
not left to an ad-hoc env var:

```json
"ticketSource": "linear",
"githubOwner": "",
"githubRepo": ""
```

`ticketSource` is `"linear"` (default when the key is absent, preserving
existing behavior) or `"github"`. `read-config.sh` validates it and fails loud
on anything else. Linear's own identifier stays the `LINEAR_TEAM_ID` secret env
var; `githubOwner`/`githubRepo` are the GitHub backend's identifiers — empty for
Linear-only projects, and both required when `ticketSource` is `"github"`.

`read-config.sh` exports these as `MUADDIB_TICKET_SOURCE` /
`MUADDIB_GITHUB_OWNER` / `MUADDIB_GITHUB_REPO`. `spawn-worker.sh` forwards them
into the worker as `TICKET_SOURCE` (defaulted from the manifest — an explicit
`TICKET_SOURCE` env var still wins, e.g. the `raw` dispatch below) plus
`GITHUB_OWNER`/`GITHUB_REPO`, where `services/ticket-source` selects the backend.

`linear`, `github`, and `raw` are peer backends, and `muaddib.sh` is the single
entry point for all three. It auto-detects its argument: a ticket reference for
the project's declared `ticketSource` (a Linear URL / `TEAM-123`, or — on a
github project — a GitHub issues URL / bare issue number) dispatches as a ticket
and lets the manifest's `ticketSource` pick linear vs github inside the worker;
anything else is free-form task text and dispatches through the `raw` backend
(`services/ticket-source/raw.js` synthesizes a ticket from the text). Detection
reuses `fetch-ticket.js`'s `extractIdentifier()` — for github it requires the
whole argument to be `#?<number>`, so a stray digit in a sentence isn't misread
as an issue number. `muaddib.sh --raw` (and its thin alias `muaddib-task.sh`)
skips detection and forces `raw`, for task text that could itself look like a
ticket reference (e.g. free-form text containing `QUO-123`).

## Autonomy level config

How much the Conductor may act on its own — before escalating a decision to a
human — is declared in `.muaddib/manifest.json`, not hard-coded:

```json
"autonomyLevel": "L0"
```

The four levels:

- **`L0`** — report-only (the default when the key is absent, preserving
  existing behavior): the Conductor never acts, it only reports.
- **`L1`** — answer low-risk/informational requests directly; escalate anything
  consequential.
- **`L2`** — act on already-confirmed outcomes without re-asking.
- **`L3`** — fully autonomous within the budget/concurrency caps in
  `.muaddib/goals.md`.

`read-config.sh` validates it and fails loud on anything else, exporting it as
`MUADDIB_AUTONOMY_LEVEL`. Node consumers read the same value through
`readAutonomyLevel(repoDir)` in `services/muaddib-config.js`, which applies the
identical `L0` default and fail-loud contract. `VALID_AUTONOMY_LEVELS`
(`services/validate-manifest.js`) is the source of truth for the enum.

## Context source config

Beyond the ticket backend, a project can declare the *other* sources of truth
the fleet should pull context from before planning/implementing — the task
manager, a decision log, process docs. These are declared in
`.muaddib/manifest.json`'s optional `contextSources` array, each entry a
`{ type, source }` pair, and resolved through the same manifest-driven registry
pattern as `ticketSource` (`services/context-source`, `getContextSource(type,
source)`):

```json
"contextSources": [
  { "type": "taskManager", "source": "linear" },
  { "type": "decisionLog", "source": "builtin" },
  { "type": "processDocs", "source": "builtin" }
]
```

The three builtins, and the `source` values each `type` accepts:

- **`taskManager`** (`linear` | `github` | `builtin`) — a thin wrapper reusing
  the `ticket-source` backends. `builtin` (the default when `source` is omitted)
  uses whatever `ticketSource` already resolves to; `linear`/`github` bind that
  specific backend.
- **`decisionLog`** (`builtin`) — wraps muaddib's own Decision Log
  (`orchestrator/decision-log.js#search`, scoped to the ticket). A single
  builtin — muaddib's internal store, not a swappable external system.
- **`processDocs`** (`builtin`) — wraps the Goal Context (`.muaddib/goals.md`
  via `services/goals.js#readGoals`, strictly read-only). **"Not configured" is
  a first-class non-error state**, mirroring the sizing hook's `{ configured:
  false }` — smaller teams often keep nothing formal here, so an absent/empty
  `goals.md` yields `{ configured: false }` rather than an error (and never
  bootstraps the default template).

Every source satisfies one deliberately narrow interface so callers treat them
uniformly:

```
name                              string identifier
gatherContext(ticketId, ticket)   -> { summary, items: [{ title, url?, body }] }
```

`contextSources` is optional and validated by `services/validate-manifest.js`:
each entry's `type` must be a known context-source type and its `source` must be
one the registry can resolve for that type, or the manifest fails validation
with a clear per-entry error — the same "must be a known backend" contract
`ticketSource` enforces. (`requirementsAndIntent`/`linkFollow` is a separate
concern; "Existing Behavior" — CLAUDE.md + `Explore` — deliberately stays out of
this registry, since it's not an external system with swappable implementations.)

### Context gathering (`## Context`)

The `gather-context` step (`scripts/gather-context.js`) turns the declared
`contextSources` into durable, discoverable context on the ticket. It runs after
`fetch-ticket` and before `analyze-ticket` in the `feature`/`bug`/`plan`
workflows (`feature-fast` deliberately skips planning, so it has no gather step).
For each configured source it calls `gatherContext(ticketId, ticket)` — reusing
the ticket object `fetch-ticket` already wrote to `/tmp/ticket-${WORKER_INDEX}.json`,
so `taskManager` needs no refetch — aggregates the results, and:

- posts them to the ticket under a searchable **`## Context`** header, mirroring
  the `## Plan` / `## Sketch` convention. An aggregate that exceeds a backend's
  comment size limit is split on source-section boundaries into
  **`## Context (n/m)`** parts (`services/context-comments.js#splitIntoParts`);
- writes the same markdown to **`.muaddib/context.md`** for same-run downstream
  steps (`analyze-ticket`, `implement`, `implement-bug` all read it when present);
- records `context_status` (`posted` | `empty` | `skipped`) to worker state.

It is **idempotent**: a re-run or resumed worker whose ticket already carries a
`## Context` comment does not re-post — it just hydrates `.muaddib/context.md`
from the existing comment(s) and records `skipped`. Read-back collects every
`## Context (n/m)` part by index and, when the current ticket has none, falls
back to the **parent** ticket's `## Context`
(`services/context-comments.js#resolveContext`) — the same own→parent precedence
`fetch-ticket` uses for `## Plan`, and which it now also applies to hydrate
`.muaddib/context.md`. (Copying a parent's context *slice* into each child at
scheduling time is a later sub-issue; only the read-back parent fallback is built
here.) Read-back goes through `TicketSource.fetchComments(id)` →
`{ own, parent }`, since `fetchTicket()` returns no comments.

## Preview server config (`services/start-servers.js`, `dispatch-daemon.js`)

Both read `.muaddib/manifest.json` directly (not through `read-config.sh`, since they
run as Node jobs rather than shell scripts) and have no built-in fallback — a
missing `.muaddib/manifest.json`, a `.muaddib/manifest.json` with no `projects` array, or one
missing `projectName` is a clear startup error, not a silent quotethat-shaped
guess. `start-servers.js` picks the API project by `seedScript` presence and
frontend projects by `devScript` presence (no project named "api"/"portal"/
"homeowner" anywhere in its own logic) — `dispatch-daemon.js` needs
`projectName` to find this project's worker containers by their compose
project label.

`start-servers.js` writes each frontend project's tunnel URL to worker state
as `<project-name>_url` (e.g. `portal_url`, `homeowner_url`) — skills that
want a preview link read the state key matching the project's own name in
`.muaddib/manifest.json`, not a separately-configured alias.

## Goal Context (`.muaddib/goals.md`)

`.muaddib/goals.md` is durable, cross-ticket **fleet policy** — budget/retry/
concurrency thresholds and durable priorities the Conductor should weigh when
managing workers over time. It's distinct from CLAUDE.md/AGENTS.md, which
describe the *product* (architecture, conventions, how to build a feature),
not how the fleet running against that product should be managed.

It's committed (not gitignored) like `.muaddib/manifest.json` — fleet policy
is a team decision, not a local/secret value. `services/goals.js`'s
`readGoals(repoDir)` reads it as opaque markdown text and, if the file doesn't
exist, bootstraps it: writes a default template to `.muaddib/goals.md` and
returns that instead of erroring, so a project that hasn't customised it yet
still gets a sane Goal Context to work with. An existing file — even a
mostly-empty one — is always returned verbatim and never overwritten.

`parseThresholds(content)` / `readGoalThresholds(repoDir)` layer a lightweight
reader over that markdown: they pull the **budget**, **concurrency**, and
**retry** caps out of it as `{ budget, concurrency, retry }` (each a number, or
`null` for "not set"). Parsing is robust to both the default template's separate
`## Budget` / `## Concurrency` / `## Retry` headings and a combined
`## Budget & retry thresholds` heading (which feeds both), strips `<!-- … -->`
placeholder hints so they can't leak a false number, and never throws. This is
a **surfacing** read — it's what lets the Fleet State report show the caps (see
below); nothing here spawns, tears down, or enforces against them. Deciding and
enforcing against Goal Context is the Conductor's job, in a later milestone.

## Decision Log (`.muaddib/decisions.jsonl`)

`.muaddib/decisions.jsonl` is a durable, citable audit trail of Conductor
Handoff Records — what was decided or escalated, and the context that
justified it. It's distinct from any system of record (Linear/GitHub): those
track tickets, not the reasoning behind fleet decisions made along the way.

Storage is append-only JSONL, one Handoff Record per line, so a lookup by ID
never has to parse more than the matching line. `orchestrator/decision-log.js`'s
`appendDecision(repoDir, scope, fields)` computes and appends a record;
`readEntries(repoDir)` reads them all back. `fields` is whatever a caller
wants to log — `id`, `scope`, and `timestamp` are always computed by the
module itself, never taken from `fields`, so they can't drift from the log's
actual state.

### Reading it back

`readEntries` is fine for ID generation, but the wrong primitive for lookups
once the log is large — it parses every line into memory. Two read functions
avoid that:

- **`getById(repoDir, id)`** returns the single record with that id, or `null`.
  It streams the log through one lazy parser and stops on the first match, so
  it never parses past the record it wanted.
- **`search(repoDir, query, opts)`** does a case-insensitive free-text match
  over each record's *content* fields (everything except the computed
  `id`/`scope`/`timestamp`, which callers filter on explicitly rather than via
  free text). It returns lightweight hits — `{ id, scope, timestamp, snippet }`,
  where `snippet` is only the matched field and a bounded, ellipsized window
  around the match — **never whole records**, so a broad query can't dump the
  log into a caller's context. `opts.scope` restricts to one ticket/`FLEET`
  scope; `opts.limit` (default 20) caps the number of hits. A caller that
  decides a hit is relevant then `getById`s the full entry.

Both share one internal iterator with `readEntries`, so all three skip
malformed lines and treat a missing file as an empty log identically.

Bash and markdown skills reach the read side through `decision-log-cli.js`
(the same pattern as `state-cli.js`/`ticket-cli.js`), resolving `repoDir` from
`REPO_DIR`:

```bash
node orchestrator/decision-log-cli.js get ADR-3-QUO-281            # prints the record, or exits 1 if absent
node orchestrator/decision-log-cli.js search "magic link" --scope QUO-281 --limit 5
```

This read interface is what a future `search-before-ask` step calls to check
whether a question was already answered before the Conductor escalates it, so
it's built to be cheap to call repeatedly and safe to expose to bash.

**Project History.** For now, Project History is satisfied *entirely* by
search-over-Decision-Log — there is no separate history store. Per the guiding
principle of not inventing a second store speculatively, that decision is
deferred until the Conductor (Milestone 4) actually needs to consume something
the Decision Log can't serve; if and when it does, that's the trigger to
revisit this.

IDs are `ADR-{seq}-{scope}`, where `scope` is a ticket id (`ADR-3-QUO-281`)
or `FLEET` when a decision isn't scoped to one ticket (`ADR-1-FLEET`) —
ticket-scoped and human-readable, borrowing uniqueness that already exists
(Linear ticket numbers) instead of manufacturing new uniqueness. `seq` is
monotonic per scope (the highest existing seq already logged for that scope,
plus one), computed under an O_EXCL file lock (`orchestrator/file-lock.js`,
shared with `orchestrator/state.js`'s `withLock` so the two can't diverge on
retry/timeout behavior) so concurrent appends to the same file can't race on
the same seq number. The lock file (`.muaddib/decisions.jsonl.lock`) only
exists for the duration of one append and is gitignored — if a worker is
killed mid-append, delete it by hand before appending again.

Ordering is deliberately *not* encoded in the ID. Each worker appends to its
own git checkout, on its own branch — two tickets' entries have no reason to
interleave numerically, and forcing them to would mean a global counter
shared across every worker on the fleet. A separate `timestamp` field carries
chronology instead, so entries merge across branches the same way any other
git-committed content does, without needing coordination between workers that
never saw each other's commits.

It's committed (not gitignored), like `.muaddib/manifest.json` and
`.muaddib/goals.md` — an audit trail only stays citable if it persists with
the code. Nothing writes real Handoff Records yet — this is just the storage
mechanism and ID generator; deciding *what* goes in one is the Conductor's
job, in a later milestone.

## Session Context (`~/.muaddib/<project>/session/`)

Goal Context and the Decision Log are the *durable* context stores — committed
in the repo tree, meant to persist across runs. Session Context is their
**ephemeral** counterpart: live working state a single Conductor run needs
while it's running, thrown away at run end and never accumulating across runs.

Because it's throwaway per-run state, it lives at
`~/.muaddib/<project>/session/session.json` — **outside the repo tree**, the
same place the per-worker env files and the dispatch ledger live, so ephemeral
run state can never be committed. (The account dir is resolved by the shared
`orchestrator/account-dir.js` helper: `MUADDIB_ACCOUNT_DIR` if set — exported
by `bin/read-config.sh` — else `~/.muaddib/<project>` from the manifest's
`projectName`, else the `~/.muaddib` account root (still outside the repo tree).
`services/dispatch-queue.js` resolves its
ledger dir through the same helper, so the two can't diverge.) No gitignore
entry is needed — the file isn't in the tree in the first place.

Storage is an **opaque key/value bag**, exactly like the per-worker
`orchestrator/state.js` — `orchestrator/session-context.js` exposes generic
`get`/`set`/`merge`/`unset`/`read`/`write(repoDir, …)` over one JSON file. No
concrete fields are defined: the shape is minimal for now and deliberately
doesn't anticipate Conductor internals. Writes go through the same O_EXCL file
lock (`orchestrator/file-lock.js`) and atomic temp-file rename as `state.js`,
so concurrent writers can't interleave or expose partial JSON.

Ephemerality ships as two guarantees that hold today even though no Conductor
drives a run lifecycle yet:

- **`clear(repoDir)`** (aliased `discard`) removes the session file — the
  explicit hook a run-end caller will use later.
- **`begin(repoDir)`** wipes any stale file up front, so a run that crashed
  before clearing can't leak its state into the next run.

Together they make "no accumulation across runs" hold now, mechanism-only,
with nothing orchestrating it — that's the Conductor's job, in a later
milestone.

Bash and markdown skills reach it through `session-context-cli.js` (the same
pattern as `state-cli.js`/`decision-log-cli.js`), resolving `repoDir` from
`REPO_DIR`:

```bash
node orchestrator/session-context-cli.js begin              # wipe any stale run state
node orchestrator/session-context-cli.js set phase implementing
node orchestrator/session-context-cli.js get phase          # -> implementing
node orchestrator/session-context-cli.js get-all            # the whole bag as JSON
node orchestrator/session-context-cli.js clear              # discard at run end
```

## Fleet Control Surface — `inspect` (`orchestrator/inspect-cli.js`)

The first Fleet Control Surface read tool: it reports live per-worker status the
same way a human reading the per-worker `.events` streams would derive it. The
Conductor's long-running `claude` session inspects fleet health by shelling into
it — the same way it runs every other orchestrator CLI (`state-cli.js`,
`decision-log-cli.js`, …).

```bash
node orchestrator/inspect-cli.js          # whole-fleet snapshot as JSON
node orchestrator/inspect-cli.js 2        # a single worker's status as JSON
node orchestrator/inspect-cli.js --report # whole-fleet human-readable report
node orchestrator/inspect-cli.js -r 2     # a single worker's human-readable report
```

Each worker folds down to a coarse `state` (latest `state_changed`), a
`currentStep` (the in-flight `step_start` with no matching `step_done`, else the
last completed step, with `running` telling the two apart), terminal
`workflowDone` / `failed` flags, and `eventCount` / `lastEventTs`.

Two properties are load-bearing and match the ticket's acceptance criteria:

- **No caching.** `orchestrator/fleet-state.js` is a pure fold over
  `events.readEvents()` with no module-level state — every call recomputes from
  the files on disk, so the output always reflects the events written *right
  now*.
- **No side effects.** The tool only reads the `.events` files; it never
  `emit()`s and never writes. `readEvents()` / `listWorkers()` (in `events.js`)
  are the read side of the same event bus, sharing the JSONL line grammar with
  `subscribe()` so a reader can't drift from the stream reader.

**`--report` (Autonomy L0).** The `--report` / `-r` flag renders that same fold
as a human-readable Fleet State report — a header (`Fleet State — <time> · N
worker(s)`), then a Goal Context **thresholds line** (`Thresholds — budget cap:
$Y · concurrency cap: N (running: M) · retry limit: R`, with `not set` for any
cap the Goal Context doesn't state), plus one aligned summary line per worker
(state, current step `(running)`/`(last)`, terminal flags, and event count /
last-event time), or a clear note when no worker has emitted yet. The thresholds
line is read live from `.muaddib/goals.md` (via `readGoalThresholds`, using
`REPO_DIR`/cwd), and `running: M` is the count of workers currently holding a
concurrency slot — i.e. with an in-flight step. It is **surfaced, not enforced**:
the report shows the caps and the live usage against them, but takes no
spawn/teardown/enforcement decision from them (that's a later Conductor
milestone). Fleet-wide spend (`$X used`) is deliberately not aggregated here —
that's spend accounting past this surfacing layer. It's a pure rendering layer
(`orchestrator/fleet-report.js`, the same formatter/data split as
`orchestrator/notify-format.js`) over `fleetState()`, so the report inherits the
**no-cache** and **no-side-effects** guarantees above unchanged: JSON stays the
default, and the flag only changes how the live fold is printed. The Conductor
daemon exposes the same report on request via `reportFleetState()`
(`services/conductor-daemon.js`) — L0 *reports and decides nothing*: it drives no
session, spawns nothing, and emits nothing.

Deeper auto-invocation from the daemon's runtime loop (the Conductor deciding
*when* to inspect or report) remains a later milestone; the report is callable by
the session — and the daemon method — as-is today.

## Prerequisites (one-time)

1. **Subscription token:** `claude setup-token` → `export CLAUDE_CODE_OAUTH_TOKEN=…`
2. **GitHub token:** a fine-grained PAT scoped to this repo, **push + open-PR
   only** (no merge, no admin) → `export GITHUB_TOKEN=…`

   > **Unattended dispatch startup.** `~/.zshrc` exports these two tokens for
   > *interactive* shells only — a dispatch daemon started at reboot / launchd /
   > cron inherits neither and worker spawning breaks silently. For that path
   > they must also live in an account-level, `chmod 600`, git-ignored
   > `~/.muaddib/conductor-secrets.env`, which `dispatch.sh` sources at startup
   > (shell env still wins). `./muaddib/install.sh` creates and populates that
   > file for you from the template (`.muaddib/conductor-secrets.env.example`).
   > Moving the exports to `~/.zshenv` is deliberately **not** done — it would
   > expose the tokens to every process on the machine.

3. **App secrets:** copy the template and fill in dev/local values:

   ```bash
   cp .muaddib/secrets.env.example .muaddib/secrets.env    # gitignored; loaded directly by spawn-worker.sh
   ```

   The template documents exactly which vars the API requires and the two value
   strategies: `test` placeholders for the test-running prototype, or real
   dev-tier keys for `npm run dev`. Two things it must respect (enforced by the
   compose regardless):
   - **No DB vars** (`PG_*`, `DATABASE_URL`, `TEST_DB_*`) — the compose pins those
     to the local sidecars and overrides anything in the file.
   - **Firebase dev creds are a file, not an env var** — only needed for
     `npm run dev`. Supply it base64'd as `FIREBASE_DEV_SA_JSON_B64` and the
     entrypoint writes it into the clone. Tests skip Firebase entirely.

   Override the path with `WORKER_SHARED_ENV` if you keep it elsewhere.

## Build the image (once, and after dependency changes)

```bash
# from the repo root — the build context must be the repo root so deps bake in
docker build -f muaddib/Dockerfile.worker -t quotethat-worker .
```

`spawn-worker.sh` also builds via `compose up --build`, but layer caching makes
that near-instant unless something changed.

**Dependencies are pre-installed into the image** (Linux-native `npm ci` for every
project listed in `.muaddib/manifest.json`'s `projects[].path`), at the final repo path.
At spawn the entrypoint `git fetch`es source *over* the baked `node_modules`
(which is gitignored, so it survives checkout) — so a spawn does **no install and
no copy**, just git deltas. Deps refresh only when a project's
`package-lock.json` drifts from the baked one, in which case just that project
runs `npm ci`. Rebuild the image to pick up new lockfiles — the deps-install
layer is keyed to the full repo copy (not just the lockfiles), so any file
change forces a rebuild of that layer, but a no-op rebuild still hits Docker's
cache entirely.

## Usage

Primary entrypoint — from the repo root, spawn a worker (auto-picks a free worker
number) and **drops you into its session**. One command covers all three ticket
sources; `muaddib.sh` auto-detects whether the argument is a ticket reference or
free-form task text:

```bash
# Ticket reference → runs /muaddib on it (linear or github, per the manifest):
npm run muaddib https://linear.app/quotethat/issue/QUO-227/...   # or just: npm run muaddib QUO-227
npm run muaddib https://github.com/owner/repo/issues/36          # or just: npm run muaddib 36   (github project)

# Free-form task text → dispatched through the raw backend, no ticket needed:
npm run muaddib "fix the auth token expiry bug in the portal"
```

To force raw dispatch when task text could itself look like a ticket reference,
use `--raw` (or the thin alias `muaddib-task.sh`):

```bash
npm run muaddib -- --raw "investigate QUO-123 regression"   # treat as task text, not ticket QUO-123
./muaddib/muaddib-task.sh "investigate QUO-123 regression"  # same thing
```

### Interacting with a worker

The agent runs in a detached **tmux session inside the container**. `npm run
muaddib` attaches you to it automatically once it's ready, so you can watch it work
and answer `/grill-me`. **Ctrl-b then d** detaches and leaves the worker running.

- Re-attach (or attach a different worker): `npm run muaddib:attach 1` (or `./muaddib/bin/attach.sh 1`)
- Monitor all workers at a glance: `./muaddib/bin/attend.sh` — bells when one is `BLOCKED` or `FAILED`
- **Persistent status board (macOS app):** `open muaddib/MuaddibApp/MuaddibApp.app` — menu bar icon; build once with `./muaddib/MuaddibApp/build.sh` (requires Xcode Command Line Tools)
- Fire-and-forget (don't auto-attach): `MUADIB_NO_ATTACH=1 npm run muaddib <ticket>`

`bin/attend.sh` is only a status board — the actual back-and-forth happens in the
attached session. Typical fleet flow: spawn a worker (auto-attach, glance, Ctrl-b
d), spawn the next, keep `bin/attend.sh` open in another pane, and `bin/attach.sh <n>`
whichever it flags.

Lower-level controls (run from `muaddib/`):

```bash
./bin/spawn-worker.sh 1 "/muaddib QUO-281"   # specific worker number / arbitrary task
./bin/spawn-worker.sh 2                      # bare interactive session
./bin/attach.sh 1                            # jump into worker 1
./bin/attend.sh                              # fleet status board (bell on BLOCKED/FAILED)
./bin/teardown-worker.sh 1
```

### The Conductor

The **Conductor** is a long-running reasoning agent (the persistent `claude`
session managed by `services/conductor-daemon.js`) — distinct from the fixed
Worker lifecycle above. Hand it a ticket or a free-form task and it starts (or,
if already running, **reuses**) its session and feeds the argument in as the
initial prompt; a leading `/` runs a skill, exactly like `spawn-worker.sh`:

```bash
npm run muaddib:conductor QUO-507                       # start + feed QUO-507 as the initial prompt
npm run muaddib:conductor "look into the flaky preview" # free-form task text
npm run muaddib:conductor -- --bg QUO-507               # same, backgrounded (PID in .muaddib-conductor.pid)
```

Run with no argument for a bare idle daemon (`npm run muaddib:conductor`, or
`--bg` to detach); `./muaddib/conductor.sh --stop` tears it down. When a daemon
is already up, a ticket/task is sent to the existing session rather than spawning
a second one.

#### Conductor skills (`conductor/`)

The Conductor has its **own** skill set, separate from the Worker skills under
`claude/skills/*`. The two never mix:

| | `claude/skills/*` (Worker skills) | `conductor/skills/*` (Conductor skills) |
|---|---|---|
| Runs on | inside each **Worker container** | the **host** Conductor session |
| Loaded by | `COPY … claude/skills/ → ~/.claude/skills/` baked into `Dockerfile.worker` | `--plugin-dir <repo>/conductor` on the Conductor's `claude` launch |
| Scope | every `claude` in the worker image | the Conductor's session only — a human running plain `claude` in the repo root does **not** get them |

`conductor/` is a minimal [Claude Code plugin](https://docs.claude.com/en/docs/claude-code/plugins):
a `conductor/.claude-plugin/plugin.json` manifest plus each skill at
`conductor/skills/<name>/SKILL.md` (same frontmatter shape as the Worker skills).
`orchestrator/conductor-session.js` appends `--plugin-dir '<repo>/conductor'` to
the `claude` command it launches (see `conductorPluginDir()`), so the skills load
for the Conductor and **only** the Conductor — no copy or symlink staging step,
no ambient leakage into other host `claude` runs. This is why the flag was chosen
over a project-local `.claude/skills/` at the repo root, which any host `claude`
started there would also pick up.

Validate the plugin (no token or running session needed — used in CI-style checks):

```bash
claude plugin validate muaddib/conductor          # manifest + every SKILL.md
claude plugin validate --strict muaddib/conductor  # warnings are errors
```

Seed skills:

- **`triage`** — a blocked or awaiting-review worker is waiting on an answer.
  Decide whether the Conductor answers directly (drafting the answer) or escalates
  to the human, weighing the project's configured autonomy level. (The concrete
  `autonomyLevel` input lands with muaddib#121; the skill references it
  conceptually until then.)
- **`dispatch-decision`** — given a ticket, decide whether to dispatch a worker
  now, defer, or skip, weighing readiness, the project's goals/concurrency limit,
  and what is already in flight.

The skills are written **agent-agnostically** — "what to decide," free of
Claude-Code-specific mechanics — so the decision prose stays portable even though
the load mechanism is Claude Code's plugin system.

## MuaddibApp — menu bar status board

A native macOS menu bar app (`muaddib/MuaddibApp/`) that replaces the
`bin/attend.sh` terminal loop with a persistent, always-visible fleet view.

**Build (once):**

```bash
# Requires Xcode Command Line Tools: xcode-select --install
./muaddib/MuaddibApp/build.sh
# → produces muaddib/MuaddibApp/MuaddibApp.app
```

**Run:**

```bash
open muaddib/MuaddibApp/MuaddibApp.app
```

A `cpu` icon appears in the menu bar. Click it to open the fleet panel:

| Element | Behaviour |
|---------|-----------|
| Colored dot | Green = running/watching, Yellow = needs attention, Red = failed, Gray = idle |
| **worker-N** + ticket ID | Worker number and Linear ticket (e.g. `QUO-335`) |
| Status label | Human-readable state (`Running`, `Blocked — needs you`, …) |
| **Attach** button | Opens a new tab in iTerm2 (if available) or Terminal.app running `docker exec -it <cid> tmux attach -t wN` |
| Pin button (📌) | Promotes the panel to floating window level so it stays visible after you click elsewhere |
| Refresh button (↺) | Forces an immediate poll (auto-polls every 2 s) |

The app reads the same `muaddib/status/worker-N.state` files as `attend.sh`
and discovers containers via `docker ps` (Docker Desktop must be running).

## ⚠ Two things to verify by hand before scaling past N=1

1. **Concurrency on one subscription.** Undocumented whether one Max plan runs
   several simultaneous interactive sessions without throttling. Spawn 2–3 and
   confirm before relying on it. This sets your real concurrency ceiling.
2. **Token-authed interactive billing.** Confirm a `CLAUDE_CODE_OAUTH_TOKEN`
   session *inside a container* meters as interactive (not the headless bucket).
   Almost certainly yes, but verify with one worker.

## Integration-test DB — done (option B)

`projects/api/scripts/test-setup.ts` used to stand up its own test DB via
`docker compose` + `docker exec` on a hardcoded `localhost:5442` — which needs a
Docker daemon the worker container deliberately lacks. The harness now honors an
externally-provided Postgres:

- `src/config/test.ts` reads `TEST_DB_HOST` / `TEST_DB_PORT` (defaults unchanged:
  `localhost:5442`), so both the test connection and migrations follow it.
- `test-setup.ts` skips all container management when `TEST_DB_EXTERNAL=1`,
  waits on the external DB via `pg_isready`, and runs migrations against it.

quotethat's DB compose overlay (`.muaddib/docker/docker-compose.worker.yml`)
already sets `TEST_DB_HOST=db_test`, `TEST_DB_PORT=5432`, `TEST_DB_EXTERNAL=1`,
so integration tests run against the `db_test` sidecar with no socket. Defaults
are preserved, so local `npm test` on your Mac is unchanged.

> This harness change lives in `projects/api/**` and should go through your
> normal review/PR — it's separable from the `muaddib/` infra.

## Running muaddib in a worker

```bash
./bin/spawn-worker.sh 1 "/muaddib QUO-281"
```

- The task arg becomes Claude's initial prompt; a leading `/` runs the skill.
- Permission mode defaults to `bypassPermissions` (the container sandbox is the
  boundary), so muaddib runs `npm`/`git`/`gh` unattended. Override per-spawn with
  `CLAUDE_PERMISSION_MODE=acceptEdits` to re-gate bash.
- `gh` is in the image and auto-auths from `GITHUB_TOKEN`, so the PR step works.
- **Linear MCP** is wired via API key: set `LINEAR_API_KEY` in `.muaddib/secrets.env` and
  the entrypoint registers the official `https://mcp.linear.app/mcp` server with a
  Bearer header (no OAuth/browser). Same tool names as the host setup, so muaddib's
  ticket read/post-back works unchanged. The key acts in Linear as you — scope it
  narrowly.
- `/grill-me` still blocks interactively — attend via tmux when a worker goes
  `BLOCKED`.

## Preview feedback loop

After opening the PR, each worker enters **FEEDBACK** mode:

1. `watch-feedback.sh` starts a tiny Node.js webhook receiver (`webhook-receiver.js`) on port 9090 and opens a cloudflared tunnel to it.
2. A Linear team webhook is registered pointing at the tunnel URL — fires on `Comment` events.
3. When you post a comment on the Linear ticket, the receiver drops a flag file. The watcher spawns a `/muaddib-feedback` Claude session in a new tmux window to address it, then returns to FEEDBACK.
4. The worker also polls the GitHub PR state every 30 s. When the PR is merged/closed, the webhook is deleted and the container is torn down.

`bin/attend.sh` shows **🔭 FEEDBACK** and **🔧 FEEDBACK_WORKING** states.

### Cleaning up stale webhooks

Workers delete their own webhook on exit (via `trap`). If a worker crashed before cleanup:

```bash
LINEAR_API_KEY=<key> ./muaddib/bin/cleanup-webhooks.sh
```

This lists and deletes all Linear webhooks whose URL contains `trycloudflare.com`.

### Token scope note

The `LINEAR_API_KEY` needs write access to webhooks — no change required to the GitHub PAT.

## Sketch: UI/UX prototyping loop

Lives in the **planning** phase, not implementation: on a `plan.json` worker
(`npm run muaddib:plan <ticket>`, or any ticket carrying the `plan` Linear
label), the agent can prototype a screen, dashboard, or any other visual
artifact as an HTML mock and hand it to you for direct review — annotate
elements/text, or submit a comment through a review button built into the
prototype — instead of a single round of "what do you think?". Built on
[lavish-axi](https://github.com/kunchenguid/lavish-axi) under the hood.

The review loop is a **project-specific workflow step**, not a special case
built into the orchestrator core — `muaddib/workflows/plan.json` declares it
using the same declarative `loop`/`claude-tui`/`runIf` primitives
`quality-loop` uses in `feature.json`/`bug.json` (`orchestrator/runner.js`
executes these; see its file header for the step-type reference). The
orchestrator itself (`orchestrator/orchestrator.js`) has no sketch-specific
states or literals; a project that doesn't declare a `sketch` step in its
workflow just never runs any of this.

- `analyze-ticket` (shared by `plan`/`feature`/`bug` workflows) decides
  whether a ticket needs a sketch pass and writes `needs_sketch` to worker
  state; only `plan.json` (the workflow that actually declares the `sketch`
  steps below) acts on it.
- `sketch` (`muaddib/claude/skills/sketch/`) is setup-only: discovers the
  target project's real design system (Mantine v8 for Portal/Homeowner
  today, not a generic Tailwind/DaisyUI default), builds the prototype with
  an explicit "Submit Review" control, opens it (`--no-open`, since the
  container has no display — the URL is published per worker at
  `http://localhost:<workerPorts.sketch + N>` (quotethat: worker 1 →
  `4387`), and notifies you via Linear + macOS.
- `sketch-review-loop` (a `loop` step in `plan.json`, capped at 200 iterations
  as a runaway backstop — a real review session is nowhere near that; hitting
  it fails the workflow rather than silently wrapping up) then repeats:
  `sketch-poll` (one bounded `lavish-axi poll` call, `awaitsReview: true` —
  see below) sets worker state `sketch_status` to `feedback` or `ended` → if
  `feedback`, `sketch-feedback` applies it (revises the prototype and
  `.muaddib/plan.md` if the approach changed) and the loop polls again → if
  `ended`, the loop exits. Submitting with no changes (or ending the session)
  is approval.
- **Status while blocked on you.** `sketch-poll`'s `awaitsReview: true` is a
  generic runner capability (any project-declared `claude-tui` step can opt
  in, not just sketch's): while that step runs, the coarse worker status is
  `AWAITING_REVIEW` — surfaced by `bin/attend.sh`, `spawn-worker.sh`'s macOS
  notifier, and MuaddibApp's status board — and reverts to `RUNNING` once it
  settles. Fires a notify event too, so you get a fresh ping each round, not
  just the first.
- **Persistence is the point.** Once the loop exits with approval,
  `sketch-finalize` (gated on `sketch_status === 'ended'`, not just
  `needs_sketch` — never runs on an exhausted/incomplete loop) exports the
  prototype and posts `## Plan` + `## Sketch` to the Linear ticket —
  `analyze-ticket` deliberately holds off posting `## Plan` itself when a
  sketch pass is pending. `implement`/`implement-bug` (running later, in a
  different worker/container) read the prototype back from that `## Sketch`
  comment — falling back to the ticket's
  parent, same as the plan fallback — since nothing on the planning worker's
  filesystem survives to the implementation run.

## Not yet wired (later layers)

- **Egress allowlist.** Restrict outbound to GitHub/npm/Linear/Anthropic to blunt
  prompt-injection exfiltration (relevant now that real Linear/dev keys live in
  the worker). Not trivial on Docker Desktop; track separately.
- **Auto-triggering** muaddib from a Linear webhook (vs. you running spawn). The
  worker side is ready; this is the orchestration layer on top.
