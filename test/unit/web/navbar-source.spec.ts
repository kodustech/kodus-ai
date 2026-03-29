import fs from 'node:fs';
import path from 'node:path';

const workspaceRoot = process.cwd();

describe('navbar source', () => {
    it('does not lazy-disable SSR for stable top-right navbar widgets', () => {
        const navbarSource = fs.readFileSync(
            path.join(
                workspaceRoot,
                'apps/web/src/core/layout/navbar/index.tsx',
            ),
            'utf8',
        );

        expect(navbarSource).not.toContain(
            'import dynamic from "next/dynamic"',
        );
        expect(navbarSource).not.toContain('const UserNav = dynamic(');
        expect(navbarSource).not.toContain('const NoSSRGithubStars = dynamic(');
        expect(navbarSource).not.toContain(
            'const NoSSRPendingRulesNotification = dynamic(',
        );
        expect(navbarSource).not.toContain('const NoSSRIssuesCount = dynamic(');
    });

    it('does not read localStorage during github stars initial render', () => {
        const githubStarsSource = fs.readFileSync(
            path.join(
                workspaceRoot,
                'apps/web/src/core/layout/navbar/_components/github-stars.tsx',
            ),
            'utf8',
        );

        expect(githubStarsSource).not.toContain(
            'useState(\n        () => localStorage.getItem',
        );
        expect(githubStarsSource).not.toContain(
            'useState(() => localStorage.getItem',
        );
    });
});
