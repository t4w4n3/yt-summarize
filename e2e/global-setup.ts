import fs from 'node:fs';
import path from 'node:path';

// Wipe the shared test database before webServers start so every run is clean.
export default async () => {
  const dataDir = path.join(import.meta.dirname, '.tmp', 'data');
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`[global-setup] wiped ${dataDir}`);
};
