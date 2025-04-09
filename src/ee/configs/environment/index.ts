/**
 * @license
 * Kodus Tech. All rights reserved.
 *
 * Smart environment loader:
 * - ✅ In dev, loads from environment.dev.ts
 * - ✅ In QA/Prod, loads from environment.ts (generated at build time)
 */

let environment;

try {
    // Dev mode: file is committed
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    environment = require('./environment.dev').environment;
} catch {
    // QA/Prod: injected during build
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    environment = require('./environment').environment;
}

export { environment };
