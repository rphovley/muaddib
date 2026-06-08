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
  container — no secret-manager indirection. The DB is safe regardless of the
  file's contents: the compose force-overrides `PG_*` / `DATABASE_URL` to the
  local sidecar, so a worker can't connect to a cloud/prod database even if a
  prod URL were dropped into the env file by mistake.
- **Easy to make interactive** When building with LLMs, often you need to come in and
  make adjustments. This setup makes it easy to let the LLMs run uninterrupted
  or jump in when needed for guidance

## `.muaddib/` project directory

The `.muaddib/` directory at the repo root is the single place for
project-owned muaddib config and setup. muaddib itself owns nothing
project-specific — all customisation lives here.

| Path | Purpose |
|------|---------|
| `.muaddib/secrets.env.example` | Committed template for the secrets bundle (gitignored: `.muaddib/secrets.env`) |
| `.muaddib/secrets.env` | Your filled-in secrets (gitignored). Copy from `secrets.env.example`. |
| `.muaddib/hooks/on-worker-start.sh` | Project hook run by the worker entrypoint after env is loaded. Executable; receives the full worker env. |
| `.muaddib/.worker-N.env` | Per-worker ephemeral env file (gitignored). Written by `spawn-worker.sh`; never edit by hand. |
| `.muaddib/plan.md` | Current implementation plan written by the muaddib fleet agent. Not tracked by git. |

### Hook contract

`worker-entrypoint.sh` does exactly two things for project setup:

1. Sources `.muaddib/secrets.env` verbatim into the worker environment.
2. If `.muaddib/hooks/on-worker-start.sh` exists and is executable, runs it with `bash`.

The hook receives the full worker env (all vars from `secrets.env` plus dynamic
values like `WORKER_INDEX`, `BRANCH`, `REPO_URL`). Use it for anything that must
happen on every worker start — materialising secret files, writing config, etc.

## Port scheme

Worker `N` (1-based):

| Service             | Host port    | Worker 1 | Worker 2 |
| ------------------- | ------------ | -------- | -------- |
| API (`npm run dev`) | `8090 + N-1` | 8090     | 8091     |
| Postgres (dev)      | `5442 + N-1` | 5442     | 5443     |
| Postgres (test)     | not published — internal `db_test:5432` |

Compose project is namespaced `quotethat-w<N>`, so containers/volumes never
collide across workers.

## Prerequisites (one-time)

1. **Subscription token:** `claude setup-token` → `export CLAUDE_CODE_OAUTH_TOKEN=…`
2. **GitHub token:** a fine-grained PAT scoped to this repo, **push + open-PR
   only** (no merge, no admin) → `export GITHUB_TOKEN=…`
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

**Dependencies are pre-installed into the image** (Linux-native `npm ci` for all
four `projects/*`), at the final repo path. At spawn the entrypoint `git fetch`es
source *over* the baked `node_modules` (which is gitignored, so it survives
checkout) — so a spawn does **no install and no copy**, just git deltas. Deps
refresh only when a project's `package-lock.json` drifts from the baked one, in
which case just that project runs `npm ci`. Rebuild the image to pick up new
lockfiles (the deps layer is cached on the lockfiles, so it only re-installs what
changed).

## Usage

Primary entrypoint — from the repo root, spawn a worker that runs `/muaddib` on a
Linear ticket (auto-picks a free worker number) and **drops you into its session**:

```bash
npm run muaddib https://linear.app/quotethat/issue/QUO-227/...   # or just: npm run muaddib QUO-227
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

The compose already sets `TEST_DB_HOST=db_test`, `TEST_DB_PORT=5432`,
`TEST_DB_EXTERNAL=1`, so integration tests run against the `db_test` sidecar with
no socket. Defaults are preserved, so local `npm test` on your Mac is unchanged.

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

## Not yet wired (later layers)

- **Egress allowlist.** Restrict outbound to GitHub/npm/Linear/Anthropic to blunt
  prompt-injection exfiltration (relevant now that real Linear/dev keys live in
  the worker). Not trivial on Docker Desktop; track separately.
- **Auto-triggering** muaddib from a Linear webhook (vs. you running spawn). The
  worker side is ready; this is the orchestration layer on top.
