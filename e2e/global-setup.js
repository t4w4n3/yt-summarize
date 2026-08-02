const fs = require('node:fs');
const path = require('node:path');

// Wipe the shared test database before webServers start so every run is clean.
module.exports = async () => {
  const dataDir = path.join(__dirname, '.tmp', 'data');
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`[global-setup] wiped ${dataDir}`);
};
