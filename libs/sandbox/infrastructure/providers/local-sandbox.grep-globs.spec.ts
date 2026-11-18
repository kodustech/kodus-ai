import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LocalSandboxService } from './local-sandbox.service';

/**
 * rg lets the later of two matching globs win. A language include placed
 * after the security scan's excludes re-admits vendor code, tests and
 * dependencies; the E2B sandbox puts the include first, and so must this one.
 */
describe('LocalSandboxService grep — language glob and scan excludes', () => {
    let repo: string;
    let rc: any;

    beforeAll(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kodus-grep-globs-'));
        for (const file of ['src/a.js', 'vendor/c.js', 'src/x.spec.js']) {
            fs.mkdirSync(path.join(repo, path.dirname(file)), {
                recursive: true,
            });
            fs.writeFileSync(path.join(repo, file), "app.get('/x', h);\n");
        }
        rc = (new LocalSandboxService({} as any) as any).buildRemoteCommands(
            repo,
        );
    });

    afterAll(() => {
        fs.rmSync(repo, { recursive: true, force: true });
    });

    it('keeps the excludes over a language include', async () => {
        const out: string = await rc.grep('app\\.get', '.', '*.js', {
            securityScan: true,
            excludeGlobs: ['vendor/**', '*.spec.js'],
        });

        expect(out).toMatch(/src\/a\.js/);
        expect(out).not.toMatch(/vendor\/c\.js/);
        expect(out).not.toMatch(/x\.spec\.js/);
    });
});
