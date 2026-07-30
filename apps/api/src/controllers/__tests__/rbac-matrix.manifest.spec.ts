import * as fs from 'fs';
import * as path from 'path';

import { buildManifest } from './rbac-matrix.shared';

/**
 * Drift guard for the RBAC manifest the full-stack e2e replays.
 *
 * `rbac-matrix.manifest.json` is the committed snapshot of every gated
 * endpoint × role verdict, derived from the controllers' @CheckPolicies and the
 * real PermissionsAbilityFactory (see rbac-matrix.shared.ts). The live e2e
 * (tests/e2e/scenarios/rbac-authorization.ts) reads it and asserts the running
 * API matches. This test fails if a controller's gating changes without
 * regenerating the manifest — so the e2e can never silently fall out of date.
 *
 * Regenerate after an intentional RBAC change:
 *   UPDATE_RBAC_MANIFEST=1 yarn test --testPathPatterns="rbac-matrix.manifest" --no-coverage
 */

const MANIFEST_PATH = path.join(__dirname, 'rbac-matrix.manifest.json');

describe('rbac matrix manifest', () => {
    it('is in sync with the controllers (regenerate with UPDATE_RBAC_MANIFEST=1)', async () => {
        const manifest = await buildManifest();

        // Sanity: the extractor actually found the gated endpoints.
        expect(manifest.length).toBeGreaterThan(30);

        const serialized = JSON.stringify(manifest, null, 2) + '\n';

        if (process.env.UPDATE_RBAC_MANIFEST) {
            fs.writeFileSync(MANIFEST_PATH, serialized);
            return;
        }

        expect(fs.existsSync(MANIFEST_PATH)).toBe(true);
        const committed = fs.readFileSync(MANIFEST_PATH, 'utf8');
        expect(serialized).toEqual(committed);
    });
});
