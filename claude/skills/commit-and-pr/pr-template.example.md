<!--
  Example muaddib PR-body override.

  Copy this file to your project's `.muaddib/pr-template.md` to customise the
  body that `commit-and-pr` / `muaddib-task` open. When `.muaddib/pr-template.md`
  exists it becomes the PR body verbatim, with shell-style variable references
  interpolated from the variables documented in the README ("PR body template"
  section). Omit the file entirely to use muaddib's generic, source-neutral default.

  This example reproduces quotethat's original Preview / Preview-credentials
  sections (API / Portal / Homeowner services, Contractor / Homeowner roles),
  which used to be hardcoded into the skills. This leading comment is stripped
  automatically at interpolation time, so it is safe to leave in place — but you
  may delete it after copying.
-->
## Summary
$PR_SUMMARY

## Ticket
$STATE_TICKET_URL

## Preview
| Service | URL |
|---------|-----|
| API | $STATE_API_TUNNEL_URL |
| Portal | $STATE_PORTAL_PREVIEW_URL |
| Homeowner | $STATE_HOMEOWNER_URL |

## Preview credentials
| Role | Login |
|------|-------|
| Contractor (Portal) | **$PREVIEW_EMAIL** / $PREVIEW_PASSWORD |
| Homeowner | $HO_CREDENTIAL |

_Preview runs in a sandboxed Docker worker. Tear down with `./muaddib/bin/teardown-worker.sh <N>`._
_Leave feedback on the PR — the agent is in feedback mode and will address it._

## Test plan
$PR_TEST_PLAN

## Review notes
$PR_REVIEW_NOTES

🤖 Generated with [Claude Code](https://claude.com/claude-code)
