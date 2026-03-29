import fs from 'node:fs';
import path from 'node:path';

describe('per repository source', () => {
    it('does not gate repository sidebar items behind mounted state', () => {
        const source = fs.readFileSync(
            path.join(
                process.cwd(),
                'apps/web/src/app/(app)/settings/_components/per-repository/repository.tsx',
            ),
            'utf8',
        );

        expect(source).not.toContain('const [mounted, setMounted]');
        expect(source).not.toContain('mounted &&');
    });

    it('renders repository items through the shared collapsible item component', () => {
        const source = fs.readFileSync(
            path.join(
                process.cwd(),
                'apps/web/src/app/(app)/settings/_components/per-repository/repository.tsx',
            ),
            'utf8',
        );

        expect(source).toContain('<RepositoryCollapsibleItem');
        expect(source).not.toContain('<Link');
    });

    it('keeps directory override count logic free of merge leftovers', () => {
        const source = fs.readFileSync(
            path.join(
                process.cwd(),
                'apps/web/src/app/(app)/settings/_components/per-repository/directory.tsx',
            ),
            'utf8',
        );

        expect(source).not.toContain(
            'const overrideCount = configOverrideCount + customMessagesOverrideCount;',
        );
        expect(source).toContain('RouteButtonWithOverrideCount');
    });
});
