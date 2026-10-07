/**
 * Task resolution: given a PR and the trackers an org connected, does the
 * judge get the task the PR points at, or stay silent, or tell the author what
 * to fix? One JSON file per case in ./fixtures. See README.md.
 *
 * A case marked `knownFailing` reproduces an open issue. It runs as
 * `it.failing`, so the suite stays green and turns red the day it starts
 * passing unannounced. BR_RESOLUTION_STRICT=1 runs it as a normal test.
 */
import fs from 'node:fs';
import path from 'node:path';

import { withDefaults } from './defaults';
import {
    CURRENT_STAGE_UNSUPPORTED,
    driveCurrentStage,
} from './drive-current-stage';

jest.setTimeout(60_000);

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const STRICT = process.env.BR_RESOLUTION_STRICT === '1';

const fixtures = fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) =>
        withDefaults(
            JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), 'utf8')),
        ),
    );

describe('business-logic task resolution', () => {
    for (const fixture of fixtures) {
        const title = `${fixture.issue} · ${fixture.name}`;
        const unsupported = CURRENT_STAGE_UNSUPPORTED.filter((f) => fixture[f]);
        if (unsupported.length) {
            it.skip(`${title} [not measurable here: ${unsupported.join(', ')}]`, () => {});
            continue;
        }

        const run = fixture.knownFailing && !STRICT ? it.failing : it;
        run(title, async () => {
            const seen = await driveCurrentStage(fixture);
            const want = fixture.expect;

            if (seen.outcome !== want.outcome) {
                throw new Error(
                    `expected ${want.outcome}, got ${seen.outcome}\n${JSON.stringify(
                        {
                            ...seen,
                            writes: seen.writes.map(
                                (w) => `${w.server}:${w.tool}`,
                            ),
                        },
                        null,
                        2,
                    )}`,
                );
            }
            for (const text of want.taskContains ?? []) {
                expect(seen.taskReadByJudge ?? '').toContain(text);
            }
            for (const text of want.taskNotContains ?? []) {
                expect(seen.taskReadByJudge ?? '').not.toContain(text);
            }
            for (const text of want.commentContains ?? []) {
                expect(seen.comment ?? '').toContain(text);
            }
            for (const text of want.commentNotContains ?? []) {
                expect(seen.comment ?? '').not.toContain(text);
            }
            if (want.judgedTasks) {
                expect(seen.judgedTasks).toEqual(want.judgedTasks);
            }
            if (want.checkPasses !== undefined) {
                expect(seen.checkPasses).toBe(want.checkPasses);
            }
            expect(seen.writes.map((w) => `${w.server}:${w.tool}`)).toEqual([]);
        });
    }
});
