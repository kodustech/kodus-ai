import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// Every module of the Runtime has an AGENTS.md whose module map matches the
// code (docs/runtime/module-docs.md): a new module ships with its doc, and a
// change of imports runs `node scripts/runtime/module-docs.mjs --write`.
describe('Runtime module docs', () => {
    it('every module has its AGENTS.md and its module map is current', () => {
        const root = join(__dirname, '..', '..');
        const r = spawnSync(process.execPath, [join(root, 'scripts', 'runtime', 'module-docs.mjs'), '--check'], { cwd: root, encoding: 'utf8' });
        expect(r.stderr).toBe('');
        expect(r.status).toBe(0);
    });
});
