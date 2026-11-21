import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { buildGoCell, GO_CELL_BINARY, goCellEnabled } from '../apps/runtime/src/testing/go-cell';

/**
 * Once per integration run (jest.integration.config.ts), before any suite:
 * with RUNTIME_IT_GO_CELL=1 the Go cell is built here, once, and every suite
 * that runs it reads its path from RUNTIME_IT_CELL_BINARY (testing/go-cell.ts).
 * Postgres is not started here: RUNTIME_IT_DATABASE_URL names a disposable
 * server (CI's service container, or docker-compose.runtime.yml locally) and
 * each suite takes a database of its own on it (isolated-database.ts).
 */
export default async function globalSetup(): Promise<void> {
    if (!goCellEnabled() || process.env[GO_CELL_BINARY]) return;
    const dir = mkdtempSync(join(tmpdir(), 'kr-it-cell-'));
    process.env[GO_CELL_BINARY] = buildGoCell(dir);
    (globalThis as { __RUNTIME_IT_CELL_DIR__?: string }).__RUNTIME_IT_CELL_DIR__ = dir;
}
