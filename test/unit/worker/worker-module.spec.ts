import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('WorkerModule telemetry wiring', () => {
    const source = readFileSync(
        join(process.cwd(), 'apps/worker/src/worker.module.ts'),
        'utf8',
    );

    function roleBranch(role: 'code-review' | 'analytics'): string {
        if (role === 'code-review') {
            const start = source.indexOf("if (role === 'code-review')");
            const end = source.indexOf('// analytics');
            return source.slice(start, end);
        }

        return source.slice(source.indexOf('// analytics'));
    }

    it('runs the self-hosted beacon on the mandatory code-review worker', () => {
        const branch = roleBranch('code-review');

        expect(source).toContain(
            "import { SelfHostedBeaconModule } from '@libs/telemetry/modules/self-hosted-beacon.module';",
        );
        expect(source).toContain(
            "import { SelfHostedBeaconCron } from './cron/self-hosted-beacon.cron';",
        );
        expect(branch).toContain('SelfHostedBeaconModule');
        expect(branch).toContain('SelfHostedBeaconCron');
    });

    it('does not run the self-hosted beacon on the optional analytics worker', () => {
        const branch = roleBranch('analytics');

        expect(branch).not.toContain('SelfHostedBeaconModule');
        expect(branch).not.toContain('SelfHostedBeaconCron');
    });
});
