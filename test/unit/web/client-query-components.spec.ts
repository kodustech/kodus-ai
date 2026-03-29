import fs from 'node:fs';
import path from 'node:path';

const workspaceRoot = process.cwd();

const queryComponentPaths = [
    'apps/web/src/app/(app)/issues/_components/status-select.tsx',
    'apps/web/src/app/(app)/issues/_components/severity-level-select.tsx',
    'apps/web/src/core/layout/navbar/_components/github-stars.tsx',
];

describe('client query components', () => {
    it('marks react-query components as client components', () => {
        for (const relativePath of queryComponentPaths) {
            const source = fs.readFileSync(
                path.join(workspaceRoot, relativePath),
                'utf8',
            );
            const header = source.split('\n').slice(0, 5).join('\n');

            expect(header).toMatch(/["']use client["']/);
        }
    });
});
