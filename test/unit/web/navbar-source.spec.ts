import fs from 'node:fs';
import path from 'node:path';

const workspaceRoot = process.cwd();

describe('navbar source', () => {
    // The navigation is the sidebar now; its stable widgets (account menu,
    // notifications, search) must still render on the server.
    it('does not lazy-disable SSR for stable navigation widgets', () => {
        const navbarSource = fs.readFileSync(
            path.join(
                workspaceRoot,
                'apps/web/src/core/layout/sidebar/index.tsx',
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
