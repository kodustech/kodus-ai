import fs from 'node:fs';
import path from 'node:path';

const workspaceRoot = process.cwd();

describe('right sidebar source', () => {
    it('does not gate sidebar buttons behind mounted placeholder returns', () => {
        const supportSource = fs.readFileSync(
            path.join(
                workspaceRoot,
                'apps/web/src/core/components/system/support-sidebar-button.tsx',
            ),
            'utf8',
        );
        const testSource = fs.readFileSync(
            path.join(
                workspaceRoot,
                'apps/web/src/app/(app)/settings/code-review/_components/preview-sidebar-button.tsx',
            ),
            'utf8',
        );

        expect(supportSource).not.toContain('if (!mounted) {');
        expect(testSource).not.toContain('if (!mounted) {');
    });

    it('keeps the test review trigger outside suspense so the icon does not appear late', () => {
        const testSource = fs.readFileSync(
            path.join(
                workspaceRoot,
                'apps/web/src/app/(app)/settings/code-review/_components/preview-sidebar-button.tsx',
            ),
            'utf8',
        );

        const tooltipProviderIndex = testSource.indexOf('<TooltipProvider>');
        const suspenseIndex = testSource.indexOf('<Suspense');
        const dryRunSidebarIndex = testSource.indexOf('<DryRunSidebar />');

        expect(tooltipProviderIndex).toBeGreaterThan(-1);
        expect(suspenseIndex).toBeGreaterThan(-1);
        expect(dryRunSidebarIndex).toBeGreaterThan(-1);
        expect(tooltipProviderIndex).toBeLessThan(suspenseIndex);
        expect(suspenseIndex).toBeLessThan(dryRunSidebarIndex);
    });

    it('does not force a second render with mounted state in right sidebar buttons', () => {
        const supportSource = fs.readFileSync(
            path.join(
                workspaceRoot,
                'apps/web/src/core/components/system/support-sidebar-button.tsx',
            ),
            'utf8',
        );
        const testSource = fs.readFileSync(
            path.join(
                workspaceRoot,
                'apps/web/src/app/(app)/settings/code-review/_components/preview-sidebar-button.tsx',
            ),
            'utf8',
        );

        expect(supportSource).not.toContain('const [mounted, setMounted]');
        expect(testSource).not.toContain('const [mounted, setMounted]');
        expect(supportSource).not.toContain('{mounted &&');
        expect(testSource).not.toContain('{mounted &&');
    });

    it('keeps route visibility decisions out of the test review button itself', () => {
        const appSidebarSource = fs.readFileSync(
            path.join(
                workspaceRoot,
                'apps/web/src/app/(app)/right-sidebar.tsx',
            ),
            'utf8',
        );
        const testSource = fs.readFileSync(
            path.join(
                workspaceRoot,
                'apps/web/src/app/(app)/settings/code-review/_components/preview-sidebar-button.tsx',
            ),
            'utf8',
        );

        expect(appSidebarSource).toContain('usePathname()');
        expect(testSource).not.toContain('usePathname');
        expect(testSource).not.toContain('isInCodeReviewSettings');
        expect(testSource).not.toContain('return null;');
    });
});
