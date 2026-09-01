## Plan

### Diagnosis

muaddib#27 ("Fleet Control Surface: send-input as a callable tool") is one of a
set of thin-wrapper "Fleet Control Surface" tools the long-running Conductor
(orchestrator/conductor-session.js, services/conductor-daemon.js) will call to
observe and steer running Workers. The Conductor skeleton merged in #23 wires up
*no* tools yet ("No Fleet Control Surface tools are wired up here — those are
later milestone issues"). This ticket adds the **send-input** tool: a callable,
independently-testable wrapper that types a line of input into a specified
running Worker's interactive Claude session, reusing the *existing* interaction
mechanism (no reimplementation).

The existing mechanism: each Worker runs its interactive `claude` inside a tmux
session named `w${N}` in a docker container. `bin/attach.sh` is the interactive
"tmux-attach-equivalent" — it resolves the container via a `docker ps` compose
label filter and runs `docker exec -it <cid> tmux attach -t w${N}`. Sending
input *non-interactively* is the same `docker exec <cid> tmux send-keys` /
`capture-pane` primitive already used by `orchestrator/job.js` (auto-accept
send-keys) and `orchestrator/conductor-session.js` (`sendPrompt`, including the
`-l` literal + `M-Enter` soft-newline handling for multi-line text). So the tool
is a thin composition of container-resolution (as in attach.sh) + tmux send-keys
(as in conductor-session.js) — no new transport.

### Solution

Follow the established `orchestrator/*-cli.js` + module + `__tests__/test-*.js`
convention (state-cli, emit-cli, ticket-cli, session-context-cli, decision-log-cli),
with an injectable exec seam exactly like `conductor-session.js._tmux` so the
tool is unit-testable with no docker, no live worker, and no Conductor logic.

**Files**

- `orchestrator/worker-input.js` (new) — the tool. Exports
  `sendInput(worker, text, opts)` and a `createWorkerInput`/class factory
  mirroring conductor-session.js's "class + factory" convention. It:
  1. Resolves the worker's container id with the *same* `docker ps` filter
     attach.sh uses: `--filter label=com.docker.compose.project=${MUADDIB_PROJECT_NAME}-w${N} --filter name=worker`, reading `MUADDIB_PROJECT_NAME` from env (present in the fleet/conductor context). Throws a clear "worker N is not running" error when empty — mirroring attach.sh's message.
  2. Sends the text via `docker exec <cid> tmux send-keys -t w${N}`, reusing
     conductor-session.js's line-splitting: `-l <line>` per line, `M-Enter`
     between lines (soft newline so multi-line input isn't submitted early),
     then a final bare `Enter` to submit.
  3. Runs every child process through an injectable `run` seam
     (default `child_process.spawnSync`), so tests assert the exact argv
     sequence without spawning anything. Returns a small structured result
     (`{ worker, container, ok }`); throws on resolution / exec failure.
- `orchestrator/worker-input-cli.js` (new) — the callable-tool surface the
  Conductor and skills shell into (they can't `require()`), matching the
  *-cli.js family. Usage: `node worker-input-cli.js <worker> [text]`. Text comes
  from argv when short, else from STDIN (large/multi-line input → stdin, same
  rationale and TTY/timeout guard as ticket-cli.js). Prints a one-line
  confirmation; non-zero exit on failure.
- `orchestrator/__tests__/test-worker-input.js` (new) — inject a fake `run` that
  records calls and returns canned results. Assert: container resolution uses
  the correct filter; a single-line send emits `send-keys -l <text>` then
  `Enter`; a multi-line send interleaves `M-Enter` between lines; an empty
  `docker ps` result throws the "not running" error; a failed `docker exec`
  surfaces as an error. No docker, no tmux, no Conductor decision-making —
  satisfying the "independently testable" acceptance criterion directly.
- `run_tests.sh` — add a `test-worker-input` line alongside the other
  orchestrator suites (the harness hard-lists each suite).

**Non-goals (deferred, per the skeleton comments):** the Conductor deciding
*when/what* to send; auto-restart; reading the worker's response back (that's a
future "inspect"-style tool). This ticket is send-only and Conductor-agnostic.

### Work Streams

**Stream 1 — Core tool module**

- Write `orchestrator/worker-input.js`: container resolution (docker ps filter
  from `MUADDIB_PROJECT_NAME`), multi-line send-keys (`-l` + `M-Enter` + trailing
  `Enter`), injectable `run` seam, structured result + clear errors.

**Stream 2 — CLI surface (depends on Stream 1)**

- Write `orchestrator/worker-input-cli.js`: parse `<worker> [text]`, read body
  from STDIN when not given on argv (reuse ticket-cli.js's stdin/TTY guard
  pattern), call `sendInput`, print confirmation, map errors to non-zero exit.

**Stream 3 — Tests (depends on Stream 1; CLI test optional)**

- Write `orchestrator/__tests__/test-worker-input.js` with the fake `run` seam
  covering the argv sequence and error paths.
- Register it in `run_tests.sh`.
- Run `./run_tests.sh` (or the single suite inside the worker container) green.

### Open Questions

<none — the interaction mechanism, worker/session naming, and container
resolution are all established in the codebase; the tool form (JS module + CLI +
seam-based test) is the repo's existing convention and directly satisfies the
"independently testable" criterion.>
