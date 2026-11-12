import * as fs from 'fs';
import * as path from 'path';

// The eval scores the Architecture template the web app's New agent dialog
// offers; `kodus agents create --template architecture` hands a team its own
// copy. Both must hand a team the same text, or the eval measures one of them.
const { readTemplate, ARCHITECTURE_CASES } = require('./architecture-cases');

const CLI_FILE = path.join(
    __dirname,
    '../../apps/cli/src/services/custom-agents.service.ts',
);
const STRING = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/;

function literal(text: string): string {
    if (text.startsWith('"')) return JSON.parse(text);
    return text.slice(1, -1).replace(/\\(['"\\])/g, '$1');
}

function cliInstructions(id: string): string {
    const source = fs.readFileSync(CLI_FILE, 'utf8');
    const start = source.indexOf(`id: '${id}',`);
    const block = source.slice(start, source.indexOf("].join('\\n')", start));
    const list = block.slice(block.indexOf('instructions: ['));
    return [...list.matchAll(new RegExp(`^\\s+(${STRING.source}),$`, 'gm'))]
        .map((m) => literal(m[1]))
        .join('\n');
}

describe('Architecture template (eval and CLI)', () => {
    it('the CLI offers the same instructions as the web app', () => {
        expect(cliInstructions('architecture')).toBe(
            readTemplate('architecture').instructions,
        );
    });

    it('names the dependency direction a domain module must not reverse', () => {
        expect(readTemplate('architecture').instructions).toMatch(
            /^Dependencies point inward: .*web framework/m,
        );
    });

    it('the eval scores the template on flags and controls', () => {
        const kinds = ARCHITECTURE_CASES.flatMap((c: any) =>
            c.expect
                .filter((e: any) => e.property === 'P13')
                .map((e: any) => (e.flag ? 'flag' : 'quiet')),
        );

        expect(kinds.sort()).toEqual(['flag', 'flag', 'quiet', 'quiet']);
    });
});
