import { buildMatrix, collectAllEndpoints, Verdict } from './rbac-matrix.shared';

/**
 * Effective authorization matrix — the flagship RBAC regression gate.
 *
 * For EVERY gated controller endpoint, the shared extractor
 * (rbac-matrix.shared.ts) statically pulls the declared
 * @CheckPolicies(checkPermissions/checkRepoPermissions/checkRole/...) and
 * evaluates the REAL verdict for each role using the REAL
 * PermissionsAbilityFactory + the REAL policy handlers, producing the
 * `endpoint × role → allow/deny` grid asserted here.
 *
 * The SAME extractor feeds rbac-matrix.manifest.json, which the full-stack e2e
 * (tests/e2e/scenarios/rbac-authorization.ts) replays against a running API —
 * so this static grid and the live test can never disagree about the matrix.
 *
 * Why static (not HTTP) here: the heavy controllers can't be mounted in
 * isolation (circular module graph), but their authorization is fully
 * determined by (declared policy) × (factory output) × (handler logic) — all
 * exercised here without importing the controllers.
 */

describe('authorization matrix (effective policy × role)', () => {
    // Expected verdict for every gated endpoint of a controller, asserted
    // across ALL of that controller's gated endpoints (robust to method
    // renames; a new endpoint with the wrong gate fails here).
    const expectController = (
        matrix: Record<string, Record<string, Verdict>>,
        filePrefix: string,
        expected: Record<string, string>,
    ) => {
        const rows = Object.fromEntries(
            Object.entries(matrix).filter(([k]) => k.startsWith(filePrefix)),
        );
        expect(Object.keys(rows).length).toBeGreaterThan(0);
        const expectedRows = Object.fromEntries(
            Object.keys(rows).map((k) => [k, expected]),
        );
        expect(rows).toEqual(expectedRows);
    };

    const ALLOW_OWNER = {
        owner: 'allow',
        billing_manager: 'deny',
        repo_admin: 'deny',
        contributor: 'deny',
    };

    it('enforces the expected verdicts for the key RBAC resources', async () => {
        const matrix = await buildMatrix();

        // Guard against a parser regression silently emptying the matrix.
        expect(Object.keys(matrix).length).toBeGreaterThan(30);

        // Bug A: BYOK delete is Owner-only (was reachable by anyone).
        expect(
            matrix['organizationParameters.controller.ts#deleteByokConfig'],
        ).toEqual(ALLOW_OWNER);

        // Bug B: Token usage — Owner/Billing/RepoAdmin read, Contributor denied.
        expectController(matrix, 'tokenUsage.controller.ts#', {
            owner: 'allow',
            billing_manager: 'allow',
            repo_admin: 'allow',
            contributor: 'deny',
        });

        // Cockpit analytics — Owner + RepoAdmin only (was tier-only).
        expectController(matrix, 'cockpit.controller.ts#', {
            owner: 'allow',
            billing_manager: 'deny',
            repo_admin: 'allow',
            contributor: 'deny',
        });

        // CLI reviews — Owner/RepoAdmin/Contributor; Billing denied.
        expectController(matrix, 'cli-reviews.controller.ts#', {
            owner: 'allow',
            billing_manager: 'deny',
            repo_admin: 'allow',
            contributor: 'allow',
        });

        // SSO config — Owner-only.
        expectController(matrix, 'ssoConfig.controller.ts#', ALLOW_OWNER);
    });

    it('every gated endpoint resolved to a known handler shape', () => {
        const unknown = collectAllEndpoints().flatMap((ep) =>
            ep.specs
                .filter((s) => s.kind === 'unknown')
                .map((s) => `${ep.key}: ${(s as any).text}`),
        );
        expect(unknown).toEqual([]);
    });
});
