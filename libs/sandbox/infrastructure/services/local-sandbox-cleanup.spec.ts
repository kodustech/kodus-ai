import { tmpdir } from 'os';
import { join } from 'path';
import { isLocalSandboxPath } from './local-sandbox-cleanup';

describe('local sandbox cleanup guards', () => {
    it('accepts direct kodus sandbox children under the OS temp directory', () => {
        expect(
            isLocalSandboxPath(join(tmpdir(), 'kodus-sandbox-test-abc')),
        ).toBe(true);
    });

    it.each([
        ['relative path', 'kodus-sandbox-test-abc'],
        ['wrong prefix', join(tmpdir(), 'not-kodus-sandbox-test-abc')],
        [
            'nested temp child',
            join(tmpdir(), 'nested', 'kodus-sandbox-test-abc'),
        ],
        ['outside temp directory', '/var/tmp/kodus-sandbox-test-abc'],
    ])('rejects unsafe local sandbox path: %s', (_label, sandboxId) => {
        expect(isLocalSandboxPath(sandboxId)).toBe(false);
    });
});
