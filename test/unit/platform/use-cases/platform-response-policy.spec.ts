/**
 * Locks in the per-platform acknowledgment behavior.
 *
 * GitLab now uses reaction (🚀) like GitHub, instead of posting a textual
 * placeholder note. This avoids the addNote argument-ordering bug that
 * surfaced as a numeric "1258376"-style placeholder appearing for ~30s.
 */

import { GitHubReaction } from '@libs/code-review/domain/codeReviewFeedback/enums/codeReviewCommentReaction.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { PlatformResponsePolicyFactory } from '@libs/platform/application/use-cases/codeManagement/policies/platform-response.policy';

describe('PlatformResponsePolicy', () => {
    describe('GitHub', () => {
        const policy = PlatformResponsePolicyFactory.create(PlatformType.GITHUB);

        it('uses a reaction (rocket) and not a textual ack', () => {
            expect(policy.usesReaction()).toBe(true);
            expect(policy.requiresAcknowledgment()).toBe(false);
            expect(policy.getAcknowledgmentReaction()).toBe(GitHubReaction.ROCKET);
            expect(() => policy.getAcknowledgmentBody()).toThrow();
        });
    });

    describe('GitLab', () => {
        const policy = PlatformResponsePolicyFactory.create(PlatformType.GITLAB);

        it('uses a reaction (rocket) and not a textual ack', () => {
            expect(policy.usesReaction()).toBe(true);
            expect(policy.requiresAcknowledgment()).toBe(false);
            expect(policy.getAcknowledgmentReaction()).toBe(GitHubReaction.ROCKET);
            expect(() => policy.getAcknowledgmentBody()).toThrow();
        });
    });

    describe('Bitbucket', () => {
        const policy = PlatformResponsePolicyFactory.create(
            PlatformType.BITBUCKET,
        );

        it('still uses a textual ack (no reaction support)', () => {
            expect(policy.usesReaction()).toBe(false);
            expect(policy.requiresAcknowledgment()).toBe(true);
            expect(policy.getAcknowledgmentBody()).toMatch(/Analyzing/);
            expect(() => policy.getAcknowledgmentReaction()).toThrow();
        });
    });

    describe('Azure Repos', () => {
        const policy = PlatformResponsePolicyFactory.create(
            PlatformType.AZURE_REPOS,
        );

        it('still uses a textual ack (no reaction support)', () => {
            expect(policy.usesReaction()).toBe(false);
            expect(policy.requiresAcknowledgment()).toBe(true);
            expect(policy.getAcknowledgmentBody()).toMatch(/Analyzing/);
            expect(() => policy.getAcknowledgmentReaction()).toThrow();
        });
    });

    describe('Forgejo', () => {
        const policy = PlatformResponsePolicyFactory.create(
            PlatformType.FORGEJO,
        );

        it('uses a reaction (rocket) and not a textual ack', () => {
            expect(policy.usesReaction()).toBe(true);
            expect(policy.requiresAcknowledgment()).toBe(false);
            expect(policy.getAcknowledgmentReaction()).toBe(GitHubReaction.ROCKET);
            expect(() => policy.getAcknowledgmentBody()).toThrow();
        });
    });
});
