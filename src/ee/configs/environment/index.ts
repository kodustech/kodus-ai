/**
 * @license
 * Kodus Tech. All rights reserved.
 *
 * Smart environment loader:
 * - ✅ In dev, loads from environment.dev.ts
 * - ✅ In QA/Prod, loads from environment.ts (generated at build time)
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { Environment } from './types';

let environment: Environment;

// Caminhos absolutos relativos ao arquivo atual
const prodPath = join(__dirname, 'environment.js'); // esse é gerado no build
const devPath = join(__dirname, 'environment.dev.js'); // sempre presente

if (existsSync(prodPath)) {
    // 🟢 Docker QA/Prod: injetado no build
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    environment = require('./environment').environment;
} else {
    // 🛠️ Dev: valor dinâmico via process.env
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    environment = require('./environment.dev').environment;
}

export { environment };
