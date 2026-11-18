import { type RuntimeRunReport, RuntimeRunReportSchema } from '@libs/runtime/run';

import { canonicalWorkspace, type RunTargetWorkspaceRef } from './run-target';
import { recipeChangedLine, renderCheckOutput, renderReportComment, runtimeLinks, type WorkspaceRefLine, workspaceLine } from './render-runtime-comment';

// What a multi-repository Run ran with besides the pull request, said in the
// comment and the check from the refs the product stored with the Run.

const links = runtimeLinks('https://app.kodus.test/', { runId: '0b9f4c1e-8d2a-4f6b-9a3c-1e2d3f4a5b6c', repositoryId: 'repo-1' });
const A = 'a1b2c3d'.padEnd(40, '0');
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

const own: WorkspaceRefLine = { alias: 'app', baseSha: B, headSha: C, source: 'pull_request' };
const billing: WorkspaceRefLine = { alias: 'billing', baseSha: A, headSha: A, source: 'default_branch' };
const web: WorkspaceRefLine = { alias: 'web', baseSha: B, headSha: C, source: 'paired', pairedPrNumber: 42 };

const report = (patch: Partial<RuntimeRunReport> = {}): RuntimeRunReport =>
    RuntimeRunReportSchema.parse({
        state: 'no_regressions',
        verdictState: 'no_regressions',
        headSha: C,
        requestedAt: '2026-11-11T14:00:00.000Z',
        trigger: 'pull_request',
        paths: [],
        uncovered: [],
        blockedOutbound: [],
        ...patch,
    });

describe('workspaceLine', () => {
    it('names each other repository at its commit, or the pull request it was paired with', () => {
        expect(workspaceLine([own, billing])).toBe('Ran with billing @ `a1b2c3d` (default branch)');
        expect(workspaceLine([own, { ...billing, branch: 'main' }])).toBe('Ran with billing @ `a1b2c3d` (main)');
        expect(workspaceLine([own, { ...billing, branch: 'release/2026.11' }])).toBe('Ran with billing @ `a1b2c3d` (release/2026.11)');
        // A branch Markdown would read as emphasis, a link or HTML stays inert in a code span.
        expect(workspaceLine([own, { ...billing, branch: '_x_[y](z)<b>' }])).toBe('Ran with billing @ `a1b2c3d` (`_x_[y](z)<b>`)');
        expect(workspaceLine([own, web])).toBe('Paired with web #42');
        expect(workspaceLine([own, billing, web])).toBe('Ran with billing @ `a1b2c3d` (default branch); paired with web #42');
    });

    it('says nothing for a Run of one repository, and drops a ref it cannot show safely', () => {
        expect(workspaceLine(undefined)).toBeUndefined();
        expect(workspaceLine([own])).toBeUndefined();
        expect(workspaceLine([{ ...billing, alias: '[x](https://evil)' }])).toBeUndefined();
        expect(workspaceLine([{ ...billing, headSha: 'not-a-sha' }])).toBeUndefined();
    });
});

describe('the comment and the check of a multi-repository Run', () => {
    it('say what the Run ran with', () => {
        const ran = { workspace: [own, billing, web] };
        expect(renderReportComment(report(), links, ran)).toContain('Ran with billing @ `a1b2c3d` (default branch); paired with web #42');
        expect(renderCheckOutput(report(), links, ran).summary).toContain('Ran with billing @ `a1b2c3d` (default branch); paired with web #42');
    });

    it('a Run of one repository renders as before', () => {
        expect(renderReportComment(report(), links, {})).toBe(renderReportComment(report(), links));
        expect(renderReportComment(report(), links)).not.toContain('Ran with');
        expect(renderCheckOutput(report(), links)).toEqual(renderCheckOutput(report(), links, {}));
    });

    it('a boot that failed because of one repository names it', () => {
        const failed = report({ state: 'could_not_boot', verdictState: 'could_not_boot', bootFailure: { failsOnBase: true, kind: 'other_repo', alias: 'billing' } });
        expect(renderReportComment(failed, links)).toContain('Fails on main too: another repository is needed in billing.');
        expect(RuntimeRunReportSchema.safeParse({ ...failed, bootFailure: { failsOnBase: true, kind: 'other_repo', alias: 'Bad/Alias' } }).success).toBe(false);
    });
});

describe('the recipe line of a PR in a member repository', () => {
    it('says its `.kodus/` changes were not applied', () => {
        expect(recipeChangedLine({ recipeChangedInPr: ['.kodus/workspace.yaml'], recipeChangedInMember: 'billing' })).toBe(
            "This pull request changes `.kodus/workspace.yaml` in billing, a member repository of this environment. Only the primary repository's recipe is applied, so these changes were not applied.",
        );
        expect(recipeChangedLine({ recipeChangedInPr: ['.kodus/workspace.yaml'] })).toContain('recipe from the base branch');
    });
});

describe('the branch of a workspace ref', () => {
    it('is part of what two targets are compared by, and absent keeps the old comparison', () => {
        const ref: RunTargetWorkspaceRef = { repositoryId: '43', alias: 'billing', baseSha: A, headSha: A, source: 'default_branch' };
        expect(canonicalWorkspace([ref])).toBe(canonicalWorkspace([{ ...ref }]));
        expect(canonicalWorkspace([{ ...ref, branch: 'main' }])).not.toBe(canonicalWorkspace([ref]));
    });
});
