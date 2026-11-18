import { rmSync } from 'fs';

/** Removes the Go cell the integration globalSetup built (jest.integration.global-setup.ts). */
export default async function globalTeardown(): Promise<void> {
    const dir = (globalThis as { __RUNTIME_IT_CELL_DIR__?: string }).__RUNTIME_IT_CELL_DIR__;
    if (dir) rmSync(dir, { recursive: true, force: true });
}
