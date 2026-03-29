import fs from 'node:fs';
import path from 'node:path';

describe('support dropdown source', () => {
    it('does not gate the navbar support dropdown behind mounted state', () => {
        const source = fs.readFileSync(
            path.join(
                process.cwd(),
                'apps/web/src/core/layout/navbar/_components/support.tsx',
            ),
            'utf8',
        );

        expect(source).not.toContain('const [mounted, setMounted]');
        expect(source).not.toContain('if (!mounted)');
    });
});
