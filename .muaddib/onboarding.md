# Onboarding a new project onto muaddib

The verified, categorized checklist of everything a repo needs to run under
muaddib, plus how the onboarding wizard (`./muaddib-onboard.sh` →
`claude/skills/onboard-project`) handles each item. This is the "design first"
artifact for muaddib#94: it is the source of truth the wizard implements, and it
records *why* each item is inferred, asked, or generated.

Everything below is confirmed against the code: `services/muaddib-config.js`,
`bin/read-config.sh`, `services/ticket-source/*`, `install.sh`,
`worker-entrypoint.sh`, `services/start-servers.js`, `services/goals.js`, and the
`.muaddib/` contract in `README.md`.

## The two rules the wizard follows

- **Infer before you ask.** Inspect the repo (git remote, existing config, ports
  in use) and *propose* a value; only ask where the repo genuinely can't tell you.
- **Generate, don't instruct.** Where a project needs a hook, a compose overlay, a
  worker-safe check command, or a PR-template override, the wizard writes the file
  itself rather than handing the operator a to-do list.

## Categorized checklist

### Account-level — verified, never re-asked (one-time per machine)

Owned by `install.sh`, not the wizard. The wizard only *checks* these and points
at the fix if one is missing.

| Item | Where | Notes |
|------|-------|-------|
| `CLAUDE_CODE_OAUTH_TOKEN` | `~/.muaddib/conductor-secrets.env` | Written by `install.sh` from `claude setup-token`. Wizard checks presence only; missing → run `install.sh`. |
| `SLACK_WEBHOOK_URL` (optional) | `~/.muaddib/conductor-secrets.env` | Documented in the conductor-secrets template but `install.sh` does **not** populate it. Wizard offers to record it; absent simply disables Slack alerts (macOS notify still fires). |
| Host tools: `docker`, `node`, `gh`, `claude`, `jq` | PATH | Already checked by `install.sh`; wizard re-checks. `cloudflared` / `flock` are optional. |

### Project-level, inferable — wizard proposes, human confirms

| Field | Inferred from |
|-------|---------------|
| `projectName` | Repo directory / git remote name. |
| `ticketSource` | `git remote get-url origin` on `github.com` → `github`; otherwise ask (Linear isn't detectable from the repo). **`raw` is never a manifest value** — it's a dispatch-time override (`muaddib.sh --raw` / `TICKET_SOURCE=raw`) synthesized from task text. |
| `githubOwner` / `githubRepo` | Parsed from the origin remote. Required when `ticketSource=github` (`read-config.sh` and the validator both enforce this). |
| `dispatchPort` + `workerPorts.{api,db,sketch}` | Scan existing `~/.muaddib/*` projects and listening ports; propose a non-colliding block. There is **no baked-in default** — `spawn-worker.sh`'s `muaddib_worker_port` errors if a base is unset. |

### Project-level, human decision

| Field | Default / notes |
|-------|-----------------|
| `model` | Default `claude-opus-4-8`. Empty → workers use the account default. |
| `retryThreshold` | Default `3` (`services/goals.js`). A non-integer silently falls back to 3, so the validator warns on a bad value. |
| `projects[]` | Each entry: `name`, `path`, `checkCommand`. Any project that runs a preview server also needs `devScript` / `seedScript` / `port` — `start-servers.js` keys API vs frontend off `seedScript` vs `devScript`. |
| `GITHUB_TOKEN` | A human mints the fine-grained PAT (scopes below); wizard writes it to `.muaddib/secrets.env`. |
| Linear creds | `LINEAR_API_KEY`, `LINEAR_TEAM_ID`, user handle — for a Linear-backed project. |
| Goal Context (`goals.md`) | Never blocking — `goals.js` bootstraps a generic template on first read. Wizard offers a project-specific pass. |

#### `GITHUB_TOKEN` scope table (fine-grained PAT, scoped to the one repo)

Mirrors `.muaddib/secrets.env.example`:

| Permission | Level | Used for |
|------------|-------|----------|
| Contents | Read & write | `worker-entrypoint.sh` clone/branch/commit/push |
| Issues | Read & write | `github.js` fetchTicket/postComment/createSubIssue; `gh issue …` |
| Pull requests | Read & write | `gh pr …`; `watch-feedback.js` polling PR state |
| Webhooks | Read & write | `watch-feedback.js` per-PR webhook register/delete |
| Metadata | Read-only | Mandatory baseline on every fine-grained PAT |

### Potentially agent-generated (only when the project's shape needs it)

| Artifact | Generate when |
|----------|---------------|
| `.muaddib/hooks/on-worker-start.sh` | Project needs per-start setup (materializing secrets, writing config). Invoked by `worker-entrypoint.sh` when present + executable. |
| `.muaddib/docker/docker-compose.worker.yml` overlay | Project needs a DB sidecar / extra services. Merged via `read-config.sh`'s `MUADDIB_COMPOSE_FILES` (spawn and teardown both use it). |
| Worker-safe `checkCommand` | The repo's test entry wraps `docker run` (like muaddib's own `run_tests.sh` off-host) — a worker has no docker.sock, so generate a docker-free variant. |
| `.muaddib/pr-template.md` (#93) | The generic default PR body doesn't fit. Seed from `claude/skills/commit-and-pr/pr-template.example.md`. |

## Validation

The wizard ends by running the consolidated validator:

```bash
node services/validate-manifest.js <repo>
```

`services/validate-manifest.js` is the single "is this manifest well-formed?"
answer — before it, the required-field / port / ticketSource checks were spread
ad-hoc across `read-config.sh`, `muaddib-config.js`, `start-servers.js`, and
`dispatch-daemon.js`. It reports **errors** (block onboarding) and **warnings**
(advisory), covering: `projectName`; `ticketSource ∈ {linear, github}` (rejecting
a manifest-level `raw`, resolving the shell-vs-`getTicketSource` discrepancy in
favor of `read-config.sh`); github owner/repo; all three `workerPorts` bases;
within-manifest port distinctness; cross-project port collisions; a non-empty
`projects[]` with `name`/`path` each; and a sane `retryThreshold`.

## Backlog-listing (deferred — its own follow-up ticket)

Confirmed that **no general list/query capability exists** on any ticket source:
the only multi-issue method is GitHub's `pollIssues()` (open issues, dispatch-only,
no filter, no CLI surface); Linear and raw have none.

**Key finding:** the credential scopes onboarding already provisions cover listing
— GitHub Issues r/w includes `GET .../issues`, and a Linear API key already permits
issue queries — so **no extra onboarding scope is needed** whether or not the
capability is built later. Deferring the capability to its own ticket therefore
forces **zero onboarding rework**. That follow-up would generalize `pollIssues()`
into a `listBacklog({filter})` across linear/github/raw plus a `ticket-cli.js list`
subcommand; it is out of scope here.
