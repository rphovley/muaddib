#!/usr/bin/env bash
# Thin launcher for the project-onboarding wizard — mirrors muaddib-task.sh's
# "thin alias over the real thing" shape, but points at an interactive `claude`
# session running the onboard-project skill instead of dispatching a fleet job.
#
# Onboarding is a HOST-interactive wizard, not a fleet worker: it inspects a
# target repo, asks the operator the handful of questions only a human can
# answer, and writes that repo's .muaddib/manifest.json + .muaddib/secrets.env.
# So unlike muaddib-task.sh (which hands off to muaddib.sh → a container), this
# just runs `claude` locally with the skill loaded.
#
#   ./muaddib-onboard.sh                 # onboard the repo in the current dir
#   ./muaddib-onboard.sh /path/to/repo   # onboard a specific repo
#
# The skill itself lives at claude/skills/onboard-project/SKILL.md. Claude Code
# discovers skills from ~/.claude/skills, so we symlink it there (idempotently)
# the same way the worker image copies claude/skills/ into ~/.claude/skills/.
set -euo pipefail

MUADDIB_DIR="$(cd "$(dirname "$0")" && pwd)"

# Target repo to onboard: first arg, or the current directory. Resolve to an
# absolute path so the skill isn't sensitive to where `claude` ends up running.
TARGET="${1:-$PWD}"
if [ ! -d "$TARGET" ]; then
    echo "muaddib-onboard: target repo '$TARGET' is not a directory" >&2
    exit 1
fi
TARGET="$(cd "$TARGET" && pwd)"

# Make the onboard-project skill discoverable to a host `claude` session by
# linking it into ~/.claude/skills (mirrors Dockerfile.worker's skills copy for
# the fleet). Idempotent: refresh the link if it points elsewhere, leave it be
# otherwise. Never touches the target repo's own .claude/.
SKILL_SRC="$MUADDIB_DIR/claude/skills/onboard-project"
if [ ! -d "$SKILL_SRC" ]; then
    echo "muaddib-onboard: skill not found at $SKILL_SRC" >&2
    exit 1
fi
SKILLS_HOME="$HOME/.claude/skills"
mkdir -p "$SKILLS_HOME"
LINK="$SKILLS_HOME/onboard-project"
if [ "$(readlink "$LINK" 2>/dev/null || true)" != "$SKILL_SRC" ]; then
    rm -rf "$LINK"
    ln -s "$SKILL_SRC" "$LINK"
fi

if ! command -v claude &>/dev/null; then
    echo "muaddib-onboard: 'claude' CLI not found — npm install -g @anthropic-ai/claude-code" >&2
    exit 1
fi

echo "→ Onboarding project at: $TARGET"
echo "  (the wizard will inspect the repo, ask a few questions, and write its .muaddib/ config)"
echo

# Run the wizard interactively from inside the target repo so the skill's repo
# inspection (git remote, existing config, ports) sees the right tree. The skill
# reads $ARGUMENTS for the target path; pass it explicitly too so it never has to
# guess. MUADDIB_DIR is exported so the skill can find the validator + templates.
cd "$TARGET"
MUADDIB_DIR="$MUADDIB_DIR" exec claude "/onboard-project $TARGET"
