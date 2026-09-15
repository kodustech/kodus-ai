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
