import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readTeamConfig, teamConfigHash } = require('./team-config');

describe('evals/shared/team-config.js', () => {
    const made: string[] = [];
    afterAll(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
    const write = (content: string) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-'));
        made.push(dir);
        const file = path.join(dir, 'config.json');
        fs.writeFileSync(file, content);
        return file;
    };

    it('names a config by its content, whatever order its keys were written in', () => {
        expect(teamConfigHash({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(teamConfigHash({ b: { d: [1, 2], c: 2 }, a: 1 }));
        expect(teamConfigHash({ a: 1 })).not.toBe(teamConfigHash({ a: 2 }));
        expect(readTeamConfig(write('{"reviewMode":"heavy"}'))).toMatchObject({ configs: { reviewMode: 'heavy' }, hash: teamConfigHash({ reviewMode: 'heavy' }) });
    });

    it('refuses what is not a team config: not JSON, not an object, or empty', () => {
        expect(() => readTeamConfig(write('nope'))).toThrow(/not a readable JSON/);
        expect(() => readTeamConfig(write('[1]'))).toThrow(/must be a JSON object/);
        expect(() => readTeamConfig(write('{}'))).toThrow(/must be a JSON object/);
    });
});
