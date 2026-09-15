import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) =>
    fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

const PAGE =
    'apps/web/src/features/ee/byok/_components/page.client.tsx';
const ROUTING_TAB =
    'apps/web/src/features/ee/byok/_components/tabs/routing-tab.tsx';
const FIRST_RUN =
    'apps/web/src/features/ee/byok/_components/first-run-card.tsx';
const BUDGET =
    'apps/web/src/features/ee/byok/_components/spend-limit-section.tsx';

describe('AI providers page source', () => {
    it('routes every tab switch through the unsaved-changes guard', () => {
        const source = read(PAGE);

        // Radix unmounts the panel it leaves and each tab re-seeds from
        // `config`, so an unguarded switch throws away an unsaved edit.
        expect(source).toContain('hasUnsavedChanges()');
        expect(source).toContain('triggerNavigationBlock()');
        expect(source).toContain('onValueChange={changeTab}');
        expect(source).not.toContain('onValueChange={setTab}');
    });

    it('registers the routing draft with that guard', () => {
        const source = read(ROUTING_TAB);

        expect(source).toContain('useUnsavedChangesGuard');
        expect(source).toContain('"byok-routing"');
    });

    it('promises the Kodus no-key path only when its tile is in the grid', () => {
        const source = read(FIRST_RUN);

        // The tile comes from the server registry, which gates `kodus`
        // separately from the web feature flag — reading the flag here told
        // orgs to pick a provider that was not on screen.
        expect(source).toContain('kodusAvailable');
        expect(source).not.toContain('useFeatureFlags');
    });

    it('sends the Budget empty state to the tab that owns the models', () => {
        const source = read(BUDGET);

        expect(source).toContain('onGoToProviders');
        // "above" was wrong: the models live on a sibling tab.
        expect(source).not.toContain('Configure a BYOK model above');
    });
});

describe('greeting source', () => {
    it('is computed in the browser, not on the server', () => {
        const source = read(
            'apps/web/src/core/components/system/greeting.tsx',
        );

        expect(source).toContain('"use client"');
        // Seeding state with the greeting leaves the server's wording on
        // screen: the effect then sets an identical value and React bails
        // out of the re-render.
        expect(source).toContain('useState("")');
        expect(source).not.toContain('useState(() => greeting');
    });

    it('has one call site so the surfaces cannot disagree', () => {
        for (const f of [
            'apps/web/src/app/(app)/issues/page.tsx',
            'apps/web/src/features/ee/cockpit/layout.tsx',
            'apps/web/src/features/ee/cockpit/_components/locked-preview.tsx',
        ]) {
            const source = read(f);
            expect(source).toContain('<Greeting />');
            expect(source).not.toContain('{greeting()}');
        }
    });
});

describe('Kodus provider card button hierarchy', () => {
    it('does not repeat the Top up label while the group is open', () => {
        const source = read(
            'apps/web/src/features/ee/byok/_components/provider-group-header.tsx',
        );

        // The header button only scrolls to the wallet below it, so expanded
        // it duplicated the wallet's own "Top up" with a different action.
        expect(source).toContain('platformFunded && !open');
        expect(source).not.toContain('variant={credits.exhausted ? "primary"');
    });

    it('keeps one primary in the wallet: the recommended pack', () => {
        const source = read(
            'apps/web/src/features/ee/byok/_components/credits-wallet.tsx',
        );

        expect(source).toContain('pack === primaryPack ? "primary" : "helper"');
        // The custom-amount action recedes instead of competing, and unlike
        // the filled variants it also recedes while disabled.
        expect(source).not.toContain('variant="helper"\n                            disabled={!canEdit || checkingOut || !customValid}');
    });

    it('uses the app-wide icon-only form for the destructive row action', () => {
        const source = read(
            'apps/web/src/features/ee/byok/_components/model-row.tsx',
        );

        expect(source).toContain('aria-label="Remove model"');
        expect(source).not.toContain('leftIcon={<TrashIcon />}');
    });
});
