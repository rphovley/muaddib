# Goal Context — muaddib (self-hosted)

Fleet policy for Workers building muaddib itself. Distinct from CLAUDE.md/AGENTS.md
(product behavior) — this is how the fleet should be managed for this repo specifically.

## Concurrency

Start conservative: 1 concurrent Worker. muaddib's own repo is small and mostly
sequential (orchestrator core, services, skills, bin scripts) — low expected value
in parallelizing until there's a real backlog depth to justify it. Raise once a
few tickets have gone through cleanly.

## Budget & retry thresholds

No numbers set yet — no historical run data for this repo to calibrate against.
Inherit the same retry-threshold precedent used elsewhere (3 consecutive failed
check passes -> FAILED, per `implementation-fleet`) until this repo's own runs
give a reason to change it.

## Known gaps blocking real dispatch (not just config)

These are two separate open items, not yet resolved — don't assume scaffolding
`.muaddib/` alone makes self-hosting work end to end:

1. **Ticket source.** Every existing skill (`grill-me-async`, `wash-hands-async`,
   `ask-questions`, etc.) reads tickets from Linear. muaddib's own backlog lives in
   GitHub Issues (`rphovley/muaddib`) — Linear must never be used for muaddib's own
   tracking (separate IP from quotethat). A GitHub-Issues ticket-fetch path is being
   scoped separately; don't invent Linear-shaped config here in the meantime.
2. **`checkScript` is intentionally unset in manifest.json.** The existing
   `run_tests.sh` shells out to `docker run` to get an isolated environment for its
   own test suite — but a self-hosted Worker already *is* that isolated container,
   and has no `docker.sock` (`docker-compose.worker.yml` mounts none, deliberately,
   to avoid root-on-host). Pointing `checkScript` at `run_tests.sh` as-is would
   attempt Docker-in-Docker and fail. A Worker-safe check script needs to run the
   same test files directly via `node` (see the body of `run_tests.sh`'s `docker run`
   block for the exact list) with no docker wrapper. Needs its own ticket.

## Not yet a blocker, but worth knowing

`worker-entrypoint.sh` sources `"$WORKDIR/muaddib/bin/read-config.sh"` — a path
that assumes `muaddib/` is always a *subdirectory* of the repo a Worker just
cloned (true when muaddib is consumed as a submodule, false when muaddib is
building itself: there's no nested `muaddib/muaddib/`). This `.muaddib/` scaffold
doesn't fix that — it's a real code change to `worker-entrypoint.sh`, out of scope
for config scaffolding. Self-hosted dispatch will fail at that `source` line until
it's addressed.
