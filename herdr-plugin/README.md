# muaddib dispatch — herdr plugin

An **optional** herdr local plugin that lets you kick off a muaddib worker
dispatch from inside herdr, without alt-tabbing out to a separate terminal and
running `npm run muaddib <ticket>` yourself.

It is **pure convenience layered on the same mechanism**: every action only
shells out to muaddib's existing dispatch entry points
(`muaddib.sh` / `muaddib-plan.sh` / `muaddib-fast.sh`). Nothing in the core
dispatch path changes, and none of this is active until you explicitly link the
plugin. On a host without herdr the files just sit here unused (zero impact),
matching the rest of muaddib's "not installed if herdr isn't present"
philosophy.

## What's here

| File | Purpose |
|------|---------|
| `herdr-plugin.toml` | Plugin manifest declaring three `[[actions]]` (discoverable through herdr's own action list) and three matching `[[panes]]` entrypoints (the actual interactive dispatch). |
| `dispatch-action.sh` | Runs *inside* a pane entrypoint herdr already opened: resolves which checkout to target (herdr's pane context → registry → linked checkout), prompts for a ticket ID, then execs that checkout's existing entry point in place. No dispatch logic of its own, and no herdr calls of its own. |

Every field/flag/env-var name below is verified against a real herdr 0.9.0
install (`herdr plugin link` / `action invoke` / `pane open`, plus reading the
launched process's actual environment) — not guessed. See
`herdr-plugin.toml`'s header comment for the specific things that turned out
different from the first draft of this plugin (wrong table names, wrong
`platforms` value, a template token that doesn't exist, etc.).

## Why an action AND a pane, per dispatch mode

`herdr plugin action invoke` runs an action's `command` as a **background,
non-interactive job** — stdout/stderr/exit code captured to a log, no TTY. It
can never satisfy `dispatch-action.sh`'s interactive ticket prompt. An
interactive, promptable terminal instead requires a `[[panes]]` **entrypoint**,
opened with `herdr plugin pane open --plugin <id> --entrypoint <id>`.

So each dispatch mode is declared twice:
- an `[[actions]]` entry — discoverable/invokable through herdr's own action
  list, whose `command` just opens the matching pane entrypoint;
- a `[[panes]]` entrypoint — where `dispatch-action.sh` actually runs, with a
  real TTY for its prompt.

| id | Title | Opens |
|----|-------|-------|
| `muaddib-dispatch` | Dispatch muaddib worker | `muaddib.sh <ticket>` (auto-detects ticket vs. task) |
| `muaddib-dispatch-plan` | Dispatch muaddib worker (plan only) | `muaddib-plan.sh <ticket>` |
| `muaddib-dispatch-fast` | Dispatch muaddib worker (fast) | `muaddib-fast.sh <ticket>` |

## Install (once)

From a host that has herdr installed:

```bash
# Register this directory as a local plugin (adjust the path to your checkout).
herdr plugin link ./muaddib/herdr-plugin --enabled

# Confirm it registered both the actions and the pane entrypoints:
herdr plugin list

# Invoke one (or find it in herdr's own action list):
herdr plugin action invoke muaddib-dispatch
herdr plugin action invoke muaddib-dispatch-plan
herdr plugin action invoke muaddib-dispatch-fast
```

Each opens a real interactive pane prompting for a ticket — confirmed by
reading the pane's contents right after invoking (`herdr pane read <id>
--source visible`) during verification.

`herdr plugin link` is the dev/install path — no GitHub install needed. Drop
`--enabled` (or use `--disabled`) if you'd rather link it inactive and enable
it later from herdr.

## Binding a keystroke (genuine one-keystroke dispatch)

herdr's own action list still costs a browse/click. For true one-keystroke
dispatch, bind a key directly to opening the pane entrypoint in your own
`~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+alt+d"
type = "pane"
command = "herdr plugin pane open --plugin muaddib-dispatch --entrypoint muaddib-dispatch"
```

`type = "pane"` opens a temporary pane for the command and closes it when the
command exits — the same shape `dispatch-action.sh` already runs in. Swap the
`--entrypoint` value for `muaddib-dispatch-plan` / `muaddib-dispatch-fast` for
a separate binding per mode, or `type = "popup"` for a modal instead of a
regular pane. See herdr's `--default-config` output (`[keys]` /
`[[keys.command]]`) for the full key-binding syntax.

## Scope — global to herdr, resolves the checkout at run time

`herdr plugin link` registers the plugin with the **herdr host** (there's one
herdr per machine), so once linked the three actions show up in herdr's action
UI from **any** pane, no matter which repo that pane is sitting in. You link it
**once**, not per project.

Which muaddib checkout a dispatch targets is then decided at **run time**, so a
single linked plugin can drive several checkouts at once — see
["Driving several projects at once"](#driving-several-projects-at-once) below.
The simplest setup (link the plugin from inside one checkout, drive only that
one) needs none of that machinery: with no registry and no pane hint, the
wrapper falls back to the checkout it's linked inside.

## Driving several projects at once

Because herdr registers the plugin host-globally, you don't want to relink every
time you switch between, say, `quotethat` and another project. `dispatch-action.sh`
therefore resolves the target checkout at dispatch time, in this priority order:

1. **`$MUADDIB_DIR`** — an explicit override, if you set it. Escape hatch / used
   by the tests.
2. **herdr's plugin invocation context** (`$HERDR_PLUGIN_CONTEXT_JSON` — one
   JSON blob herdr injects into the launched process's env, carrying
   `focused_pane_cwd`/`workspace_cwd` among other fields) — the wrapper walks
   up from the focused pane's CWD to the nearest muaddib checkout (a dir with
   an executable `muaddib.sh`). So a dispatch just targets the repo of the
   pane you invoked it from — no prompt, no config. When the variable is
   absent or `jq` isn't installed, this step is silently skipped and the
   registry below takes over.
3. **A project registry** — a plain-text file, default
   `${XDG_CONFIG_HOME:-~/.config}/muaddib/herdr-projects` (override with
   `$MUADDIB_HERDR_REGISTRY`), one entry per line:

   ```
   # shortname            absolute path to the checkout
   quotethat              /Users/you/src/quotethat
   otherproj              /Users/you/src/otherproj
   ```

   Blank lines and `#` comments are ignored. **One** entry is used silently;
   **several** make the wrapper print a numbered picker — choose by number or by
   shortname, then it prompts for the ticket as usual. Adding a project is a
   one-line edit; no re-link. Rather than hand-edit, use the helper (idempotent,
   validates the path, keeps comments/other entries):

   ```bash
   # from inside a checkout — dir defaults to that checkout
   ./bin/herdr-register.sh quotethat
   # or point it anywhere
   ./bin/herdr-register.sh otherproj /Users/you/src/otherproj
   ```

   `muaddib-onboard.sh` runs this for you when you onboard a new project (only if
   herdr is on your PATH or you already have a registry — it won't create config
   otherwise).
4. **Legacy fallback** — the checkout this plugin is physically linked inside
   (`<checkout>/herdr-plugin/`). This is the original single-project behavior and
   what you get when you set up neither a pane hint nor a registry.

So, concretely, to drive several projects: either rely on the pane hint (nothing
to configure, if your herdr passes pane CWD), or drop a couple of lines in the
registry file and pick from the menu at dispatch time. You never link/unlink to
switch projects.

### Setting it up across projects you already have

If you already have muaddib checked out in several projects on this machine
(`quotethat`, another repo, …), you don't install the plugin per project — you
link it **once** and register the checkouts:

1. **Link the plugin once**, from any one of your checkouts (it's host-global
   from then on):

   ```bash
   herdr plugin link ./muaddib/herdr-plugin --enabled
   ```

2. **Register each existing checkout** so the picker (and single-project silent
   resolution) knows about them. From inside each checkout:

   ```bash
   ./bin/herdr-register.sh quotethat        # dir defaults to this checkout
   ```

   Or register them all in one sweep from wherever your projects live — this
   finds every muaddib checkout and registers it under its parent repo's name:

   ```bash
   find ~/src -maxdepth 4 -name muaddib.sh -type f 2>/dev/null | while read -r m; do
     dir="$(cd "$(dirname "$m")" && pwd)"
     # Prefer the project's declared name. The manifest lives at the repo root —
     # the checkout itself (self-hosted) or its parent (muaddib as a submodule).
     name=""
     for mf in "$dir/.muaddib/manifest.json" "$(dirname "$dir")/.muaddib/manifest.json"; do
       [ -f "$mf" ] && name="$(jq -r '.projectName // empty' "$mf")" && [ -n "$name" ] && break
     done
     [ -n "$name" ] || name="$(basename "$dir")"   # fall back to the dir name
     "$dir/bin/herdr-register.sh" "$name" "$dir"
   done
   ```

   (Adjust `~/src` and the name rule to taste — the registry is just a text file
   you can also edit by hand.)

3. That's it. Invoke `muaddib-dispatch` from herdr and pick the project; new
   projects you onboard later register themselves via `muaddib-onboard.sh`.

You can skip step 2 entirely for day-to-day use — a dispatch just targets
whatever project the pane is in. The registry is the portable fallback for
when the pane you invoked from isn't inside any checkout (e.g. invoked from
herdr's own action list rather than from within a pane sitting in a project).

## Verified against a real host

Earlier drafts of this plugin were written without access to a real herdr
install and got several things wrong (wrong table names, an invalid
`platforms` value, a template token that doesn't exist, an unsupported
`pane open` invocation shape, and — the biggest one — routing the interactive
ticket prompt through `action invoke`, which runs headless with no TTY and can
never receive it). Everything in this manifest and `dispatch-action.sh` has
since been re-verified end-to-end against a real herdr 0.9.0 install:
`herdr plugin link` accepts the manifest, `herdr plugin action invoke
muaddib-dispatch` opens a real pane, and reading that pane's contents
(`herdr pane read <id> --source visible`) shows the actual ticket prompt.

You can still smoke-test the wrapper standalone, independent of herdr, the same
way the test suite does:

```bash
echo "QUO-227" | bash ./muaddib/herdr-plugin/dispatch-action.sh default
```
