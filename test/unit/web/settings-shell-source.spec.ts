import fs from 'node:fs';
import path from 'node:path';

describe('settings shell source', () => {
    it('keeps the shell visible instead of returning a plain loading message', () => {
        const source = fs.readFileSync(
            path.join(
                process.cwd(),
                'apps/web/src/app/(app)/settings/_components/_layout.tsx',
            ),
            'utf8',
        );

        expect(source).not.toContain('Loading settings...');
        expect(source).toContain('SettingsShellContentSkeleton');
    });

    it('does not branch the shell through hydrated or mounted flags', () => {
        const source = fs.readFileSync(
            path.join(
                process.cwd(),
                'apps/web/src/app/(app)/settings/_components/_layout.tsx',
            ),
            'utf8',
        );

        expect(source).not.toContain('const [hydrated, setHydrated]');
        expect(source).not.toContain('if (!hydrated)');
        expect(source).not.toContain('const [mounted, setMounted]');
        expect(source).not.toContain('mounted && !isShellLoading');
    });
});
