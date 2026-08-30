#!/usr/bin/env bash
# Decide whether the worker image needs a rebuild, and resolve the build
# inputs (effective Dockerfile.worker, MUADDIB_PREFIX build arg) once, so
# spawn-worker.sh and run_tests.sh can't drift on this the way the codebase
# drifted on the nested-path assumption everywhere else this session.
# Source this script — do not execute directly. Requires read-config.sh
# already sourced (needs REPO_ROOT).

# Why a hash, not just "does the tag exist": most of what's baked into the
# image re-syncs from git at container runtime — worker-entrypoint.sh does a
# `git fetch --depth 1 origin main && git checkout -f` on /home/worker/repo —
# so a stale image is harmless for that content. Two things are NOT covered
# by that re-sync, and are exactly what went stale silently, repeatedly:
#   - worker-entrypoint.sh itself: it's the container's ENTRYPOINT, already
#     executing by the time its own git checkout runs, so a stale baked-in
#     copy keeps running no matter what's on origin/main.
#   - claude/ (settings.json, skills/, claude.json, tmux.conf): COPYed to
#     /home/worker/.claude/..., a path the runtime checkout never touches.
# Also hashed: Dockerfile.base and the effective Dockerfile.worker
# themselves — if a COPY/RUN/ARG line changes, the old image structurally
# can't reflect that regardless of any file's content.
#
# The hash is stored as a Docker image label at build time (not a hash file
# on disk), so it survives host reboots and can't get out of sync by being
# deleted separately from the image itself.

# Effective Dockerfile.worker: project override takes precedence.
muaddib_worker_dockerfile() {
    local fleet_dir="$1" repo_root="$2"
    local project_dockerfile="$repo_root/.muaddib/Dockerfile.worker"
    if [ -f "$project_dockerfile" ]; then
        echo "$project_dockerfile"
    else
        echo "$fleet_dir/Dockerfile.worker"
    fi
}

# Consuming projects have muaddib nested at REPO_ROOT/muaddib, so
# Dockerfile.worker's COPY sources are prefixed muaddib/ (its default).
# Self-hosting builds with REPO_ROOT already at muaddib's own root — no
# prefix needed.
muaddib_docker_prefix() {
    local repo_root="$1"
    if [ -d "$repo_root/muaddib" ]; then
        echo "muaddib/"
    else
        echo ""
    fi
}

# Combined hash of everything baked into the image that isn't re-synced from
# git at container runtime, plus the build instructions themselves. Hashing
# each file individually (rather than concatenating raw content) means an
# added/removed/renamed file changes the result too, not just edited content.
muaddib_image_build_hash() {
    local fleet_dir="$1" worker_dockerfile="$2"
    {
        shasum -a 256 "$fleet_dir/Dockerfile.base" "$worker_dockerfile" "$fleet_dir/worker-entrypoint.sh"
        find "$fleet_dir/claude" -type f -print0 | sort -z | xargs -0 shasum -a 256
    } | shasum -a 256 | awk '{print $1}'
}

# True (exit 0) if the image needs building: missing, or its stored
# build-hash label doesn't match the current one.
muaddib_image_needs_rebuild() {
    local image="$1" hash="$2"
    local existing
    existing="$(docker image inspect --format '{{ index .Config.Labels "muaddib.build-hash" }}' "$image" 2>/dev/null || true)"
    [ -n "$existing" ] && [ "$existing" = "$hash" ] && return 1
    return 0
}
