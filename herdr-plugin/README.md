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
| `dispatch-action.sh` | Thin wrapper an action runs: prompts for a ticket ID, then calls the existing entry point in a plugin-owned pane. No dispatch logic. |

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

## Scope — global to herdr, bound to one checkout

Both halves of the answer matter, because they pull in opposite directions:

- **Availability is global to your herdr install.** `herdr plugin link`
  registers the plugin with the herdr host (there's one herdr per machine), so
  once linked the three actions show up in herdr's action UI from **any** pane,
  no matter which repo that pane happens to be sitting in. You don't re-link per
  project, and you don't have to be "inside" muaddib to invoke a dispatch.
- **But each link is bound to the one muaddib checkout you pointed it at.** The
  wrapper resolves the checkout root *relative to its own location*
  (`MUADDIB_DIR="$PLUGIN_DIR/.."` in `dispatch-action.sh`), so an action always
  dispatches a worker into the checkout whose `herdr-plugin/` you linked —
  regardless of your current pane's directory. The path you pass to
  `herdr plugin link ./muaddib/herdr-plugin` is what decides that, permanently,
  for that link.

So: install it **once**, host-wide, and it's available everywhere in herdr — but
it drives **one** muaddib checkout. If you keep several muaddib checkouts and
want to dispatch into a specific one, link that checkout's `herdr-plugin/` (and,
if you want more than one live at a time, give each a distinct `name` in its
`herdr-plugin.toml` so their action ids don't collide). To repoint an existing
link at a different checkout, unlink and re-link from the new path.

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
