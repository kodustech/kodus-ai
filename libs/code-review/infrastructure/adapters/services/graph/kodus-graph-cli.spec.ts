import { readFileSync } from 'fs';
import { join } from 'path';

import {
    KODUS_GRAPH_CONTEXT_BUDGET,
    KODUS_GRAPH_VERSION,
    KodusGraphCli,
} from './kodus-graph-cli';

describe('KodusGraphCli.context', () => {
    it('passes the prompt budget to the CLI instead of relying on its defaults', async () => {
        const run = jest
            .fn()
            .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
        const sandbox = { type: 'local', repoDir: '/repo', run } as any;

        await new KodusGraphCli().context(sandbox, ['src/a.ts'], {
            outPath: '/tmp/out/context.xml',
        });

        const command: string = run.mock.calls[0][0];
        expect(command).toContain(
            `--max-functions ${KODUS_GRAPH_CONTEXT_BUDGET.maxFunctions}`,
        );
        expect(command).toContain(
            `--max-callees ${KODUS_GRAPH_CONTEXT_BUDGET.maxCallees}`,
        );
    });
});

describe('KODUS_GRAPH_VERSION', () => {
    it('pins the graph release that emits direct callee context', () => {
        expect(KODUS_GRAPH_VERSION).toBe('0.3.3');
    });

    // The images preinstall the CLI. Any other version there makes the local
    // sandbox reinstall it from npm on every review.
    it.each(['docker/Dockerfile', 'docker/Dockerfile.dev'])(
        'matches the version %s installs',
        (dockerfile) => {
            const content = readFileSync(
                join(__dirname, '../../../../../..', dockerfile),
                'utf8',
            );
            expect(content).toMatch(
                new RegExp(
                    `^ARG KODUS_GRAPH_VERSION=${KODUS_GRAPH_VERSION}$`,
                    'm',
                ),
            );
        },
    );
});
