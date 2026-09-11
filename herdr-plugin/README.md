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
| `herdr-plugin.toml` | Plugin manifest declaring the three dispatch actions. |
| `dispatch-action.sh` | Thin wrapper an action runs: resolves which checkout to target (pane CWD → registry → linked checkout), prompts for a ticket ID, then calls that checkout's existing entry point in a plugin-owned pane. No dispatch logic. |

## Actions

| Action id | Title | Runs |
|-----------|-------|------|
| `muaddib-dispatch` | Dispatch muaddib worker | `muaddib.sh <ticket>` (auto-detects ticket vs. task) |
| `muaddib-dispatch-plan` | Dispatch muaddib worker (plan only) | `muaddib-plan.sh <ticket>` |
| `muaddib-dispatch-fast` | Dispatch muaddib worker (fast) | `muaddib-fast.sh <ticket>` |

Because herdr actions have no native input-prompt, the wrapper prompts for the
ticket reference (or, for the default action, free-form task text) itself, then
dispatches into a **plugin-owned pane** (`herdr plugin pane open`) so your
current pane stays unblocked.

## Install (once)

From a host that has herdr installed:

```bash
# Register this directory as a local plugin (adjust the path to your checkout).
herdr plugin link ./muaddib/herdr-plugin --enabled

# Confirm the actions registered:
herdr plugin action list

# Invoke one (or use herdr's action UI):
herdr plugin action invoke muaddib-dispatch
herdr plugin action invoke muaddib-dispatch-plan
herdr plugin action invoke muaddib-dispatch-fast
```

`herdr plugin link` is the dev/install path — no GitHub install needed. Drop
`--enabled` (or use `--disabled`) if you'd rather link it inactive and enable
it later from herdr.

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
2. **herdr's active-pane directory** (`$HERDR_PANE_CWD`, then `$HERDR_CWD`) — the
   wrapper walks up from it to the nearest muaddib checkout (a dir with an
   executable `muaddib.sh`). So a dispatch just targets the repo of the pane you
   invoked it from — no prompt, no config. *The env-var names are best-effort
   against herdr 0.8.0; confirm them on your host (see "Verifying on a real
   host"). When they aren't provided, this step is silently skipped and the
   registry below takes over.*
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
   one-line edit; no re-link.
4. **Legacy fallback** — the checkout this plugin is physically linked inside
   (`<checkout>/herdr-plugin/`). This is the original single-project behavior and
   what you get when you set up neither a pane hint nor a registry.

So, concretely, to drive several projects: either rely on the pane hint (nothing
to configure, if your herdr passes pane CWD), or drop a couple of lines in the
registry file and pick from the menu at dispatch time. You never link/unlink to
switch projects.

## Verifying on a real host

herdr is a host-only macOS binary and isn't present in the muaddib worker
container, so parts of this manifest are **best-effort** and should be
confirmed during your first `herdr plugin link` pass:

- The **exact TOML nesting** of the manifest. The field *names* used here
  (`name`, `version`, `platforms`, `pane`, `action` with `id`/`title`,
  `min_herdr_version`) are confirmed to exist in the herdr 0.8.0 binary, but
  the nesting/structure and the per-action `command` field are not verified.
- Whether `contexts` / `startup` are **required** (they exist in the schema but
  aren't declared here).
- The exact flags for **`herdr plugin pane open`** in `dispatch-action.sh` —
  only the subcommand's existence is verified, not its argument shape.
- The **plugin-dir variable** (`${PLUGIN_DIR}`) the action `command`s use to
  locate `dispatch-action.sh` independently of herdr's action CWD — the exact
  variable name herdr substitutes is not verified.

If `herdr plugin link` rejects the manifest, adjust the nesting/flags to match
what your herdr version reports and re-link. The wrapper falls back to a direct
in-terminal dispatch when `herdr` isn't on PATH, so you can smoke-test it
standalone first:

```bash
echo "QUO-227" | bash ./muaddib/herdr-plugin/dispatch-action.sh default
```
