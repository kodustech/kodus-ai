import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

describe('NEST_APP_OPTIONS', () => {
    it('is what every Nest entry point in the repository boots with', () => {
        // A boot without it gets a second ScheduleModule and runs every
        // @Cron twice per process.
        const root = join(__dirname, '../../../..');
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                if (name === 'node_modules' || name.startsWith('.')) continue;
                const path = join(dir, name);
                if (statSync(path).isDirectory()) {
                    walk(path);
                    continue;
                }
                if (!path.endsWith('.ts') || path.endsWith('.spec.ts'))
                    continue;
                // Mentions in comments are not calls.
                const text = readFileSync(path, 'utf8')
                    .replace(/\/\*[\s\S]*?\*\//g, '')
                    .replace(/\/\/.*$/gm, '');
                // Each call up to its closing `);`, where its options sit.
                const calls =
                    text.match(
                        /NestFactory\.(?:create|createApplicationContext)\s*(?:<[^>]*>)?\s*\([\s\S]*?\);/g,
                    ) ?? [];
                if (
                    calls.some((call) => !call.includes('...NEST_APP_OPTIONS'))
                ) {
                    offenders.push(path.slice(root.length + 1));
                }
            }
        };
        for (const dir of ['apps', 'libs', 'scripts']) {
            walk(join(root, dir));
        }

        expect(offenders).toEqual([]);
    });
});
