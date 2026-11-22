import { readFileSync } from 'fs';
import { join } from 'path';

import { checkCliInstallCommand } from './cli-install';

// The same cases run in apps/runtime-cell/internal/drivers/dockergvisor/toollayer
// (install_test.go): the cell never runs an install the API would refuse.
const FIXTURE = join(
    __dirname,
    '../../../../../runtime/protocol/cli-install-commands.json',
);
const CELL_COPY = join(
    __dirname,
    '../../../../../../apps/runtime-cell/internal/drivers/dockergvisor/toollayer/cli-install-commands.json',
);

interface Case {
    name: string;
    command: string;
    ok: boolean;
    installer?: string;
    reasonContains?: string;
}

const cases: Case[] = JSON.parse(readFileSync(FIXTURE, 'utf8')).cases;

describe('checkCliInstallCommand shared fixtures', () => {
    it('the cell copy is byte-identical', () => {
        expect(readFileSync(CELL_COPY).equals(readFileSync(FIXTURE))).toBe(
            true,
        );
    });

    it.each(cases)('$name', (c) => {
        const result = checkCliInstallCommand(c.command);
        expect(result.ok).toBe(c.ok);
        if (result.ok) {
            expect(result.installer).toBe(c.installer);
        } else {
            expect(result.reason).toContain(c.reasonContains);
        }
    });
});
