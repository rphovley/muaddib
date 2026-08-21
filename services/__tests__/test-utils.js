'use strict';
// Shared helpers for the services/__tests__ suite.

const fs = require('fs');
const path = require('path');

// Writes repoDir/.muaddib/manifest.json, creating the .muaddib/ dir first.
function writeManifest(repoDir, contents) {
  const dir = path.join(repoDir, '.muaddib');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), contents);
}

module.exports = { writeManifest };
