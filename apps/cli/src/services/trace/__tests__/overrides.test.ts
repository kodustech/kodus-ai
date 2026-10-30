import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readOverrides } from '../overrides.js';
import { overridesPath } from '../store-paths.js';

const { cliDebug } = vi.hoisted(() => ({ cliDebug: vi.fn() }));
vi.mock('../../../utils/logger.js', () => ({ cliDebug }));

describe('readOverrides', () => {
    let gitRoot: string;
    let traceHome: string;

    beforeEach(async () => {
        gitRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-overrides-'));
        traceHome = await fs.mkdtemp(
            path.join(os.tmpdir(), 'trace-overrides-home-'),
        );
        process.env.KODUS_TRACE_HOME = traceHome;
        cliDebug.mockClear();
    });

    afterEach(async () => {
        delete process.env.KODUS_TRACE_HOME;
        await Promise.all(
            [gitRoot, traceHome].map((entry) =>
                fs.rm(entry, { recursive: true, force: true }),
            ),
        );
    });

    it('treats a missing file as an expected empty state', async () => {
        await expect(readOverrides(gitRoot)).resolves.toEqual({
            forgotten: [],
            pinned: [],
        });
        expect(cliDebug).not.toHaveBeenCalled();
    });

    it('records a diagnostic when the file is malformed', async () => {
        const filePath = overridesPath(gitRoot);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, '{not-json', 'utf-8');

        await expect(readOverrides(gitRoot)).resolves.toEqual({
            forgotten: [],
            pinned: [],
        });
        expect(cliDebug).toHaveBeenCalledWith(
            'Failed to read Trace overrides; using empty overrides',
            expect.objectContaining({ filePath, errorName: 'SyntaxError' }),
        );
    });
});
