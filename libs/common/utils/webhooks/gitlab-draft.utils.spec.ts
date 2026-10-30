import {
    isGitlabDraftToReadyChange,
    resolveGitlabDraftStatus,
} from './gitlab-draft.utils';

describe('resolveGitlabDraftStatus', () => {
    it('returns true when draft is true and work_in_progress is false', () => {
        expect(
            resolveGitlabDraftStatus({ draft: true, work_in_progress: false }),
        ).toBe(true);
    });

    it('returns false when draft is false even if work_in_progress is true', () => {
        expect(
            resolveGitlabDraftStatus({ draft: false, work_in_progress: true }),
        ).toBe(false);
    });

    it('falls back to work_in_progress when draft is null', () => {
        expect(
            resolveGitlabDraftStatus({ draft: null, work_in_progress: true }),
        ).toBe(true);
    });

    it('falls back to work_in_progress when draft is missing', () => {
        expect(resolveGitlabDraftStatus({ work_in_progress: true })).toBe(true);
    });

    it('returns false when both fields are missing', () => {
        expect(resolveGitlabDraftStatus({})).toBe(false);
    });
});

describe('isGitlabDraftToReadyChange', () => {
    it('detects draft true to false', () => {
        expect(
            isGitlabDraftToReadyChange({
                draft: { previous: true, current: false },
            }),
        ).toBe(true);
    });

    it('detects work_in_progress true to false', () => {
        expect(
            isGitlabDraftToReadyChange({
                work_in_progress: { previous: true, current: false },
            }),
        ).toBe(true);
    });

    it('falls back to work_in_progress when draft change values are null', () => {
        expect(
            isGitlabDraftToReadyChange({
                draft: { previous: null, current: null },
                work_in_progress: { previous: true, current: false },
            }),
        ).toBe(true);
    });

    it('does not let work_in_progress override explicit draft change values', () => {
        expect(
            isGitlabDraftToReadyChange({
                draft: { previous: false, current: false },
                work_in_progress: { previous: true, current: false },
            }),
        ).toBe(false);
    });

    it('does not mix draft previous true with work_in_progress current false', () => {
        expect(
            isGitlabDraftToReadyChange({
                draft: { previous: true, current: null },
                work_in_progress: { previous: false, current: false },
            }),
        ).toBe(false);
    });

    it('does not mix work_in_progress previous true with draft current false', () => {
        expect(
            isGitlabDraftToReadyChange({
                draft: { previous: null, current: false },
                work_in_progress: { previous: true, current: true },
            }),
        ).toBe(false);
    });

    it('falls back to work_in_progress when draft previous is null and current is false', () => {
        expect(
            isGitlabDraftToReadyChange({
                draft: { previous: null, current: false },
                work_in_progress: { previous: true, current: false },
            }),
        ).toBe(true);
    });

    it('falls back to work_in_progress when draft previous is true and current is null', () => {
        expect(
            isGitlabDraftToReadyChange({
                draft: { previous: true, current: null },
                work_in_progress: { previous: true, current: false },
            }),
        ).toBe(true);
    });

    it('returns false for work_in_progress false to true', () => {
        expect(
            isGitlabDraftToReadyChange({
                work_in_progress: { previous: false, current: true },
            }),
        ).toBe(false);
    });
});
