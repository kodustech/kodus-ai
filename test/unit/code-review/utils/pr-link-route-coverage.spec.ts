import * as fs from 'fs';
import * as path from 'path';

import { buildKodyRuleLink } from '@libs/code-review/utils/build-kody-rule-link';
import { buildKodyRuleAppLink } from '@libs/ee/kodyRules/utils/build-rule-link';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

/**
 * Every external app link Kody pastes into a PR must land on a real web
 * route — a dead link in a PR comment is invisible to unit tests of the
 * builders alone (they only check the string shape). This spec closes
 * the loop: it generates every link VARIATION the backend can emit into
 * a PR (both rule-link builders + the static links hardcoded in PR
 * comment templates) and asserts each pathname resolves against the
 * actual Next.js App Router tree in apps/web/src/app.
 *
 * If someone moves/removes a route the links depend on (e.g. the
 * /kody-rules/[id] deep-link page), this fails at unit-test time
 * instead of as a customer-reported dead link (see the David B /
 * directory-scoped incident in build-kody-rule-link.ts).
 */

const APP_DIR = path.resolve(__dirname, '../../../../apps/web/src/app');

const PAGE_FILE = /^page\.(tsx|jsx|ts|js)$/;
const LAYOUT_FILE = /^layout\.(tsx|jsx|ts|js)$/;

const readEntries = (dir: string) =>
    fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [];

/** A directory renders a page if it has page.tsx, a route group that
 *  does, or is a parallel-routes container (layout + @slot pages). */
const dirRendersPage = (dir: string): boolean => {
    const entries = readEntries(dir);

    if (entries.some((e) => e.isFile() && PAGE_FILE.test(e.name))) {
        return true;
    }

    // route groups are transparent: (group)/page.tsx serves this path
    if (
        entries.some(
            (e) =>
                e.isDirectory() &&
                e.name.startsWith('(') &&
                dirRendersPage(path.join(dir, e.name)),
        )
    ) {
        return true;
    }

    // parallel routes: layout.tsx + at least one @slot rendering a page
    const hasLayout = entries.some(
        (e) => e.isFile() && LAYOUT_FILE.test(e.name),
    );
    if (hasLayout) {
        return entries.some(
            (e) =>
                e.isDirectory() &&
                e.name.startsWith('@') &&
                dirRendersPage(path.join(dir, e.name)),
        );
    }

    return false;
};

const matchSegments = (dir: string, segments: string[]): boolean => {
    if (segments.length === 0) {
        return dirRendersPage(dir);
    }

    const [head, ...rest] = segments;

    for (const entry of readEntries(dir)) {
        if (!entry.isDirectory()) {
            continue;
        }
        const child = path.join(dir, entry.name);

        // route groups don't consume a URL segment
        if (entry.name.startsWith('(')) {
            if (matchSegments(child, segments)) {
                return true;
            }
            continue;
        }

        // parallel route slots don't map to URL segments
        if (entry.name.startsWith('@')) {
            continue;
        }

        const isDynamic =
            entry.name.startsWith('[') && entry.name.endsWith(']');
        if (entry.name === head || isDynamic) {
            if (matchSegments(child, rest)) {
                return true;
            }
        }
    }

    return false;
};

const routeExists = (pathname: string): boolean => {
    const segments = pathname.split('/').filter(Boolean);
    return matchSegments(APP_DIR, segments);
};

const pathnameOf = (url: string): string => new URL(url).pathname;

const BASE = 'https://app.kodus.io';

describe('PR external links → web route coverage', () => {
    it('sanity: the route matcher resolves a known route and rejects garbage', () => {
        expect(routeExists('/settings')).toBe(true);
        expect(routeExists('/definitely/not/a/route')).toBe(false);
    });

    describe('buildKodyRuleLink (file-level, PR-level and agent review pipelines)', () => {
        const variations: Array<{ name: string; url: string }> = [
            {
                name: 'global rule, no extras',
                url: buildKodyRuleLink(BASE, 'rule-1', {}),
            },
            {
                name: 'global rule with teamId',
                url: buildKodyRuleLink(
                    BASE,
                    'rule-1',
                    { repositoryId: 'global' },
                    { teamId: 'team-1' },
                ),
            },
            {
                name: 'repo-level rule',
                url: buildKodyRuleLink(
                    BASE,
                    'rule-1',
                    { repositoryId: '1190062595' },
                    { teamId: 'team-1' },
                ),
            },
            {
                name: 'directory-scoped rule (David B bug shape)',
                url: buildKodyRuleLink(
                    BASE,
                    'rule-1',
                    { repositoryId: '1190062595', directoryId: 'dir-1' },
                    { teamId: 'team-1' },
                ),
            },
        ];

        it.each(variations)('$name resolves to a real route', ({ url }) => {
            expect(routeExists(pathnameOf(url))).toBe(true);
        });
    });

    describe('buildKodyRuleAppLink (kodyRules service + MCP tools)', () => {
        const variations: Array<{ name: string; url: string }> = [
            {
                name: 'active rule deep link (review-rules tab)',
                url: buildKodyRuleAppLink({
                    repositoryId: '1190062595',
                    ruleId: 'rule-1',
                    teamId: 'team-1',
                    tab: 'review-rules',
                    baseUrl: BASE,
                }),
            },
            {
                name: 'active memory deep link (memories tab)',
                url: buildKodyRuleAppLink({
                    repositoryId: 'global',
                    ruleId: 'rule-1',
                    tab: 'memories',
                    baseUrl: BASE,
                }),
            },
            {
                name: 'pending rule → list page fallback',
                url: buildKodyRuleAppLink({
                    repositoryId: '1190062595',
                    ruleId: 'rule-1',
                    status: KodyRulesStatus.PENDING,
                    tab: 'review-rules',
                    baseUrl: BASE,
                }),
            },
            {
                name: 'missing ruleId → list page fallback',
                url: buildKodyRuleAppLink({
                    repositoryId: null,
                    ruleId: undefined,
                    tab: 'review-rules',
                    baseUrl: BASE,
                }),
            },
        ];

        it.each(variations)('$name resolves to a real route', ({ url }) => {
            expect(routeExists(pathnameOf(url))).toBe(true);
        });
    });

    describe('static links hardcoded in PR comment templates', () => {
        // Keep in sync with the templates; each entry names its source so a
        // failure points straight at the comment that would ship the dead
        // link.
        const staticLinks: Array<{ source: string; pathname: string }> = [
            {
                source: 'commentManager.service.ts (review dashboard link)',
                pathname: '/pull-requests',
            },
            {
                source: 'commentManager.service.ts (configurationLink)',
                pathname: '/settings/code-review/global/general',
            },
            {
                source: 'validate-prerequisites.stage.ts (plan expired ×2)',
                pathname: '/settings/subscription',
            },
            {
                source: 'validate-prerequisites.stage.ts (BYOK missing)',
                pathname: '/organization/byok',
            },
        ];

        it.each(staticLinks)(
            '$source → $pathname resolves to a real route',
            ({ pathname }) => {
                expect(routeExists(pathname)).toBe(true);
            },
        );
    });
});
