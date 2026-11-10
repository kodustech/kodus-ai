import { kodusFilesChangedBy, RECIPE_FILE_PATHS, recipeFilesChangedBy } from '@libs/runtime/contracts/enums';
import { RUNTIME_RECIPE_PATH, RUNTIME_RECIPE_PATHS, RUNTIME_ONLY_RECIPE_PATH } from '@libs/runtime/contracts/runtime-commands';
import { RuntimeRunReportSchema, RuntimeRunRequestedSchema } from '@libs/runtime/run';

import { diffForRun } from '../application/run-request-builder.service';

// S-19: a PR that changes the recipe still runs with the base's (ADR-012), and is told so.
describe('recipe changed in the PR (S-19)', () => {
    it('the recipe paths are one vocabulary, in the order the setup reads them', () => {
        expect(RUNTIME_RECIPE_PATHS).toBe(RECIPE_FILE_PATHS);
        expect([RUNTIME_ONLY_RECIPE_PATH, RUNTIME_RECIPE_PATH]).toEqual(['.kodus/workspace.runtime.yaml', '.kodus/workspace.yaml']);
    });

    it('reports the root .kodus/ files: the workspace files first, once each, then the others sorted, bounded', () => {
        expect(kodusFilesChangedBy(['src/a.ts', '.kodus/workspace.yaml', '.kodus/workspace.runtime.yaml', '.kodus/workspace.yaml'])).toEqual([
            '.kodus/workspace.runtime.yaml',
            '.kodus/workspace.yaml',
        ]);
        expect(kodusFilesChangedBy(['.kodus/compose.yaml', 'src/a.ts', '.kodus/workspace.yaml', '.kodus/Dockerfile.backend'])).toEqual([
            '.kodus/workspace.yaml',
            '.kodus/Dockerfile.backend',
            '.kodus/compose.yaml',
        ]);
        expect(kodusFilesChangedBy(['x/.kodus/workspace.yaml', '.kodus/../etc/passwd', '.kodus/', 'kodus/compose.yaml', undefined])).toEqual([]);
        expect(kodusFilesChangedBy(Array.from({ length: 30 }, (_, i) => `.kodus/f${String(i).padStart(2, '0')}.yaml`))).toHaveLength(20);
    });

    it('the recipe is only what the claims replace: the workspace files and the setup authored files (kr-grafana #7)', () => {
        const changed = ['.kodus/compose.yaml', '.kodus/Dockerfile.backend', '.kodus/workspace.yaml', '.kodus/Dockerfile.kody', 'src/a.ts'];
        // The repository commits its recipe: the compose and Dockerfile it names boot from the PR.
        expect(recipeFilesChangedBy(changed, {})).toEqual(['.kodus/workspace.yaml']);
        expect(recipeFilesChangedBy(['.kodus/compose.yaml'], {})).toEqual([]);
        // Kody authored the recipe: its files are written from the setup record, never the PR's copy.
        expect(recipeFilesChangedBy(changed, { files: [{ path: '.kodus/Dockerfile.kody' }] })).toEqual(['.kodus/workspace.yaml', '.kodus/Dockerfile.kody']);
        // No recipe in the claims: the PR's own workspace file boots.
        expect(recipeFilesChangedBy(changed, undefined)).toEqual([]);
    });

    it('the Run request carries the files the product saw, with or without a cut diff', () => {
        const files = [{ path: 'src/a.ts', patch: '@@' }];
        expect(diffForRun({ files, truncated: false, recipeFiles: ['.kodus/workspace.yaml'] })).toEqual({
            diff: files,
            prChangedRecipeFiles: ['.kodus/workspace.yaml'],
        });
        expect(diffForRun({ files, truncated: true, recipeFiles: ['.kodus/workspace.yaml'] })).toMatchObject({
            diffTruncated: true,
            prChangedRecipeFiles: ['.kodus/workspace.yaml'],
        });
        expect(diffForRun({ files, truncated: false })).toEqual({ diff: files });
    });

    it('the schemas accept only the fixed paths, so no repo text reaches the PR through them', () => {
        const field = RuntimeRunRequestedSchema.shape.prChangedRecipeFiles;
        expect(field.safeParse(['.kodus/workspace.yaml']).success).toBe(true);
        expect(field.safeParse(['README.md']).success).toBe(false);
        const reportField = RuntimeRunReportSchema.shape.recipeChangedInPr;
        expect(reportField.safeParse(['.kodus/workspace.runtime.yaml']).success).toBe(true);
        expect(reportField.safeParse(['[link](https://x)']).success).toBe(false);
        expect(reportField.safeParse([]).success).toBe(false);
    });
});
