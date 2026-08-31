'use strict';
// Shared resolver for the account-level per-project directory
// (~/.muaddib/<project>/) — the place any module puts generated state that
// must live OUTSIDE the repo tree. Extracted so the several callers that
// resolve this path can't diverge on it, the same anti-drift reason
// muaddib-config.js and bin/read-config.sh exist.
//
// Resolution order:
//   1. MUADDIB_ACCOUNT_DIR — the explicit override, exported by
//      bin/read-config.sh ($HOME/.muaddib/$MUADDIB_PROJECT_NAME). Honoring it
//      keeps the JS default from diverging from the shell's notion of the
//      account dir, and lets tests point it at a temp dir.
//   2. readMuaddibConfig(repoDir).projectName → ~/.muaddib/<project>.
//   3. If neither is available (manifest missing/unreadable), degrade to the
//      account root ~/.muaddib rather than crash. This stays OUTSIDE the repo
//      tree so the "generated state is never committed" guarantee holds even in
//      the degraded case — returning repoDir here would drop state into the repo.

const os = require('os');
const path = require('path');
const { readMuaddibConfig } = require('../services/muaddib-config');

function resolveAccountDir(repoDir) {
  if (process.env.MUADDIB_ACCOUNT_DIR) return process.env.MUADDIB_ACCOUNT_DIR;
  try {
    const { projectName } = readMuaddibConfig(repoDir);
    if (projectName) return path.join(os.homedir(), '.muaddib', projectName);
  } catch (_) {}
  return path.join(os.homedir(), '.muaddib');
}

module.exports = { resolveAccountDir };
