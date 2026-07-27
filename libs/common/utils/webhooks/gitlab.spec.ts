import { GitlabMappedPlatform, resolveGitlabIsDraft } from './gitlab';

describe('resolveGitlabIsDraft', () => {
    it('treats draft:null + work_in_progress:true as draft (old GitLab, issue #1514)', () => {
        expect(
            resolveGitlabIsDraft({ draft: null, work_in_progress: true }),
        ).toBe(true);
    });

    it('returns true when draft is true', () => {
        expect(resolveGitlabIsDraft({ draft: true })).toBe(true);
    });

    it('lets an explicit draft:false win over work_in_progress:true', () => {
        expect(
            resolveGitlabIsDraft({ draft: false, work_in_progress: true }),
        ).toBe(false);
    });

    it('falls back to work_in_progress:false when draft is null', () => {
        expect(
            resolveGitlabIsDraft({ draft: null, work_in_progress: false }),
        ).toBe(false);
    });

    it('returns false when both fields are absent', () => {
        expect(resolveGitlabIsDraft({})).toBe(false);
    });

    it.each([[null], [undefined]])('returns false for %p', (mr) => {
        expect(resolveGitlabIsDraft(mr as any)).toBe(false);
    });
});

describe('GitlabMappedPlatform.mapPullRequest — draft detection', () => {
    it('maps a Draft MR reported with draft:null + work_in_progress:true as isDraft=true', () => {
        const payload: any = {
            object_kind: 'merge_request',
            event_type: 'merge_request',
            object_attributes: {
                iid: 8423,
                title: 'Draft: something',
                state: 'opened',
                draft: null,
                work_in_progress: true,
                source_branch: 'feature',
                target_branch: 'main',
                labels: [],
            },
            repository: { name: 'repo' },
        };

        const result = new GitlabMappedPlatform().mapPullRequest({ payload });

        expect(result?.isDraft).toBe(true);
    });
});
