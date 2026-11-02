import { cli } from './runtime.js';
await cli('check-config', 'all', async ({ config }) => ({ valid: true, dataDirectory: config.dataDir, dryRun: config.dryRun, note: 'Local validation only; no API requests made.' }));
