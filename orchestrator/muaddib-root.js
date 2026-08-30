'use strict';
// Consuming projects have muaddib checked out as a nested submodule
// (REPO/muaddib); muaddib building itself has no such nesting — the clone
// IS muaddib, so its own orchestrator/, services/, workflows/ etc. sit
// directly at REPO. Shared by orchestrator/*.js and services/*.js so they
// can't drift on this resolution the way the shell scripts once did.

const fs = require('fs');
const path = require('path');

function resolveMuaddibRoot(repoDir) {
  const nested = path.join(repoDir, 'muaddib');
  return fs.existsSync(nested) ? nested : repoDir;
}

module.exports = { resolveMuaddibRoot };
