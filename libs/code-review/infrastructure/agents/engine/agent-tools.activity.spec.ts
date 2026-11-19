import {
    activitySnapshot,
    runActivity,
} from '@libs/core/infrastructure/activity/activity-registry';

import { buildAgentTools } from './agent-tools.factory';

/**
 * Every tool call is marked in flight for its job, for the stall report and
 * the BetterStack alert. The summary names the call, never the agent's
 * search text: a pattern copied from the diff can be a secret.
 */
describe('agent tools — activity of a tool call', () => {
    it('marks the call in flight with its path and glob, never its pattern', async () => {
        let during: ReturnType<typeof activitySnapshot> = [];
        const remote: any = {
            grep: async () => '',
            read: async () => '',
            listDir: async () => '',
            exec: async () => {
                during = activitySnapshot();
                return { stdout: 'src/a.ts:1:x', stderr: '', exitCode: 0 };
            },
        };
        await runActivity('job-1', {}, () =>
            buildAgentTools(remote).grep.execute({
                pattern: 'sk_live_FAKE_SECRET',
                path: 'src',
                glob: '*.ts',
            }),
        );
        const tools = during[0]?.tools ?? [];
        expect(tools).toEqual([
            expect.objectContaining({
                tool: 'grep',
                args: 'path=src glob=*.ts',
            }),
        ]);
        expect(JSON.stringify(during)).not.toContain('sk_live_FAKE_SECRET');
        // Ended with the call.
        expect(activitySnapshot()).toEqual([]);
    });
});
