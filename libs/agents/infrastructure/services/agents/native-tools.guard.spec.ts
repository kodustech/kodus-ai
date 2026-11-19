import type { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';
import {
    activitySnapshot,
    runActivity,
} from '@libs/core/infrastructure/activity/activity-registry';

import {
    buildNativeToolConfigs,
    MAX_CONVERSATION_TOOL_OUTPUT_CHARS,
} from './native-tools.factory';

/**
 * The conversation agent's tools get what the code review tools get: no
 * secret file's content, no huge line, a bounded answer, and the call marked
 * in flight for the stall watchdog.
 */
describe('conversation tools — guarded outputs', () => {
    const huge = 'x'.repeat(300_000);
    const make = (over: Record<string, unknown> = {}) => {
        const remote: any = {
            grep: jest.fn().mockResolvedValue(''),
            read: jest.fn().mockResolvedValue(''),
            listDir: jest.fn().mockResolvedValue(''),
            exec: jest
                .fn()
                .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
            ...over,
        };
        const tools = buildNativeToolConfigs({
            remoteCommands: remote,
            cleanup: jest.fn(),
            type: 'local',
        } as unknown as SandboxInstance);
        const run = (name: string, input: unknown) =>
            tools.find((t) => t.name === name)!.execute(input);
        return { remote, run };
    };

    it.each([
        ['readFile', { path: '.env', start: 1, end: 5 }],
        ['readFile', { path: 'certs/server.pem', start: 1, end: 5 }],
        ['grep', { pattern: 'x', path: '.env.production' }],
        ['exec', { command: 'cat .env' }],
        ['exec', { command: "head -n 5 'keys/id_rsa'" }],
    ])('refuses %s on a secret file (%j)', async (name, input) => {
        const { remote, run } = make();
        const out = (await run(name, input)) as any;
        expect(out.error).toContain('secret file');
        expect(remote.read).not.toHaveBeenCalled();
        expect(remote.exec).not.toHaveBeenCalled();
    });

    it('drops secret file lines from grep and exec output', async () => {
        const text =
            'src/a.ts:1:ok\n.env:1:API_TOKEN=FAKE_VALUE\ncerts/x.pem:2:KEY';
        const { run } = make({
            grep: jest.fn().mockResolvedValue(text),
            exec: jest
                .fn()
                .mockResolvedValue({ stdout: text, stderr: '', exitCode: 0 }),
        });
        expect(((await run('grep', { pattern: 'x' })) as any).matches).toBe(
            'src/a.ts:1:ok',
        );
        expect(((await run('exec', { command: 'rg x' })) as any).stdout).toBe(
            'src/a.ts:1:ok',
        );
    });

    it('cuts a huge line and caps the answer', async () => {
        const many = Array.from(
            { length: 200 },
            (_, i) => `f${i}.ts:1:${'y'.repeat(1_500)}`,
        ).join('\n');
        const { run } = make({
            grep: jest.fn().mockResolvedValue(`dist/app.min.js:1:${huge}`),
            read: jest.fn().mockResolvedValue(many),
        });
        const grep = ((await run('grep', { pattern: 'x' })) as any)
            .matches as string;
        expect(grep.length).toBeLessThan(3_000);
        expect(grep).toContain('more characters on this line not shown');
        const read = (
            (await run('readFile', {
                path: 'a.ts',
                start: 1,
                end: 9_999,
            })) as any
        ).content as string;
        expect(read.length).toBeLessThanOrEqual(
            MAX_CONVERSATION_TOOL_OUTPUT_CHARS + 200,
        );
        expect(read).toContain('more characters not shown');
    });

    it('marks the call in flight with its path, and an exec only by its program', async () => {
        const seen: string[] = [];
        const { run } = make({
            read: jest.fn(async () => {
                seen.push(activitySnapshot()[0]?.tools?.[0]?.args ?? '');
                return 'x';
            }),
            exec: jest.fn(async () => {
                seen.push(activitySnapshot()[0]?.tools?.[0]?.args ?? '');
                return { stdout: '', stderr: '', exitCode: 0 };
            }),
        });
        await runActivity('job', {}, async () => {
            await run('readFile', { path: 'src/a.ts', start: 3, end: 9 });
            await run('exec', { command: 'git log --grep sk_live_FAKE' });
        });
        expect(seen).toEqual(['path=src/a.ts start=3 end=9', 'command=git']);
    });
});
