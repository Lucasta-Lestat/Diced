'use strict';
// Entry point for `node --test apps-script/test`: Node resolves a directory
// argument to its index.js, so load every *.test.js from here.
const fs = require('node:fs');
const path = require('node:path');

for (const file of fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort()) {
  require(path.join(__dirname, file));
}
