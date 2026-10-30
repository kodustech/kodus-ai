/**
 * The null sandbox must not answer with manufactured silence (issue #1826).
 *
 * Derived from spec.md KRC-02: "IF repository lookup is unavailable THEN the
 * system SHALL raise an error from `grep` and `read` instead of returning an
 * empty string." `listDir` is covered by the same reasoning — an empty listing
 * is read downstream as "the directory holds nothing", which is a claim this
 * object is in no position to make.
 *
 * Consumers that legitimately run without a repository gate on
 * `type === 'null'`; that contract is asserted here too, because it is what
 * makes the throw safe.
 */
import {
    NULL_SANDBOX_INSTANCE,
    NullSandboxProvider,
} from './null-sandbox.service';
import { buildNativeToolConfigs } from '@libs/agents/infrastructure/services/agents/native-tools.factory';

describe('NULL_SANDBOX_INSTANCE — raises instead of answering empty (KRC-02)', () => {
    it('grep throws rather than resolving an empty string', async () => {
        await expect(
            NULL_SANDBOX_INSTANCE.remoteCommands.grep('formatDate', '.'),
        ).rejects.toThrow(/No sandbox configured/);
    });

    it('read throws rather than resolving an empty string', async () => {
        await expect(
            NULL_SANDBOX_INSTANCE.remoteCommands.read('src/a.ts', 1, 20),
        ).rejects.toThrow(/No sandbox configured/);
    });

    it('listDir throws rather than resolving an empty string', async () => {
        await expect(
            NULL_SANDBOX_INSTANCE.remoteCommands.listDir('src', 1),
        ).rejects.toThrow(/No sandbox configured/);
    });

    it('says what it could not do, so the log names the operation', async () => {
        await expect(
            NULL_SANDBOX_INSTANCE.remoteCommands.read('src/a.ts', 1, 20),
        ).rejects.toThrow(/cannot read src\/a\.ts/);
    });

    it('states that "cannot look" is not "found nothing"', async () => {
        await expect(
            NULL_SANDBOX_INSTANCE.remoteCommands.grep('x', '.'),
        ).rejects.toThrow(/not the same as looking and finding nothing/);
    });

    it('still identifies itself as the null sandbox, which is how consumers gate', () => {
        expect(NULL_SANDBOX_INSTANCE.type).toBe('null');
        expect(NULL_SANDBOX_INSTANCE.sandboxId).toBe('');
    });

    it('leaves readFile, writeFile and run exactly as they were', async () => {
        await expect(NULL_SANDBOX_INSTANCE.readFile('a')).rejects.toThrow(
            'No sandbox configured',
        );
        await expect(NULL_SANDBOX_INSTANCE.writeFile('a', 'b')).rejects.toThrow(
            'No sandbox configured',
        );
        await expect(NULL_SANDBOX_INSTANCE.run('ls')).resolves.toEqual({
            stdout: '',
            stderr: '',
            exitCode: 1,
        });
    });

    it('the provider itself reports unavailable and refuses to create', async () => {
        const provider = new NullSandboxProvider();
        expect(provider.isAvailable()).toBe(false);
        await expect(provider.createSandboxWithRepo()).rejects.toThrow(
            'No sandbox provider configured',
        );
    });
});

describe('the audited consumers still hold with the throw', () => {
    it('buildNativeToolConfigs registers NO tools for a null sandbox, so it never calls one', () => {
        // The conversation path (chatWithKodyFromGit) passes NULL_SANDBOX_INSTANCE
        // straight through when the lease cannot be acquired. It gates on
        // `type === 'null'` before touching remoteCommands, which is what makes
        // the throw safe there.
        expect(buildNativeToolConfigs(NULL_SANDBOX_INSTANCE)).toEqual([]);
    });
});
