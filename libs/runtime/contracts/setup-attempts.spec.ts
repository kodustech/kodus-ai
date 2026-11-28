import { SETUP_AUTHOR_REPAIRS_MAX } from '@libs/runtime/run/environment-setup';

import { RecipeAuthorRequestSchema } from './recipe-author';
import { setupRepoTokensAttemptOf } from './setup-repo-tokens';

const SHA = 'a'.repeat(40);

describe('the attempts a setup names in its calls', () => {
    it("Kody's author is asked for the first authoring or a repair the setup can make; a worker that names none is still answered", () => {
        const ok = (attempt?: string) => RecipeAuthorRequestSchema.safeParse({ sha: SHA, ...(attempt === undefined ? {} : { attempt }) }).success;
        expect([undefined, 'author-0', 'repair-1', `repair-${SETUP_AUTHOR_REPAIRS_MAX}`].map(ok)).toEqual([true, true, true, true]);
        expect(['author-1', 'repair-0', `repair-${SETUP_AUTHOR_REPAIRS_MAX + 1}`, 'learn-1', ''].map(ok)).toEqual([false, false, false, false, false]);
    });

    it("a learn-loop boot and its replay are the same hypothesis of the loop; the setup's first boot is its own kind", () => {
        expect(['boot', 'learn-1', 'learn-2', 'learn-3', 'learn-4', 'repair-2'].map(setupRepoTokensAttemptOf)).toEqual([
            { kind: 'boot', n: 0 },
            { kind: 'learn', n: 1 },
            { kind: 'learn', n: 1 },
            { kind: 'learn', n: 2 },
            { kind: 'learn', n: 2 },
            { kind: 'repair', n: 2 },
        ]);
    });
});
