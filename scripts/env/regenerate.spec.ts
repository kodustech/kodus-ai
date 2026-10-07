import { execFileSync, execSync } from 'node:child_process';
import { isAbsolute } from 'node:path';

jest.mock('node:child_process', () => ({
    execFileSync: jest.fn(),
    execSync: jest.fn(),
}));

import { regenerateEnvArtefacts } from './regenerate';

/**
 * The regression (#2045) was the SHAPE of the invocation, not its arguments:
 * the script path travelled inside a shell string, so a checkout under
 * `.../Documents/2. Areas/...` reached ts-node as `.../Documents/2.` and every
 * push from that checkout was rejected by the pre-push hook.
 *
 * These cases pin the shape — a command and an argv entry, no shell — because
 * that is what makes the path immune to what it contains. The end-to-end proof
 * is running the guard from a checkout whose path has a space; it needs a real
 * ts-node and a real repo root, so it stays out of the unit suite.
 */
describe('regenerateEnvArtefacts (#2045)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('passes the generator as an argv entry instead of interpolating it', () => {
        regenerateEnvArtefacts('/tmp/out');

        // The shell form is the bug: it must not be used at all.
        expect(execSync).not.toHaveBeenCalled();
        expect(execFileSync).toHaveBeenCalledTimes(1);

        const [file, args, options] = (execFileSync as jest.Mock).mock.calls[0];

        // Two separate values. Nothing re-splits them, so a path with a space
        // arrives whole.
        expect(file).toBe('ts-node');
        expect(Array.isArray(args)).toBe(true);
        expect(args).toHaveLength(1);
        expect(args[0]).toMatch(/scripts[/\\]env[/\\]generate\.ts$/);

        // No shell, and the caller's own cwd is not inherited.
        expect(options.shell).toBeUndefined();
        expect(isAbsolute(options.cwd)).toBe(true);
    });

    it('still points the generator at the requested output directory', () => {
        regenerateEnvArtefacts('/tmp/env-out');

        const [, , options] = (execFileSync as jest.Mock).mock.calls[0];

        expect(options.env.KODUS_ENV_OUT_DIR).toBe('/tmp/env-out');
        // The rest of the environment is inherited, as before.
        expect(options.env.PATH).toBe(process.env.PATH);
        expect(options.stdio).toBe('inherit');
    });
});
