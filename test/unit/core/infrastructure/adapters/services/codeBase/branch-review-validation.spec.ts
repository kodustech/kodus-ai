import {
    processExpression,
    shouldReviewBranches,
    mergeBaseBranches,
} from '@/core/infrastructure/adapters/services/codeBase/branchReview.service';

describe('Branch Review Validation - Integration Tests', () => {
    describe('Branch Validation with mergeBaseBranches and shouldReviewBranches', () => {
        it('should validate branches with wildcards - case from test.json', () => {
            // Setup from test.json
            const originalConfig = ['develop', 'feature/*', 'release/*'];
            const apiBaseBranch = 'refs/heads/master';
            const sourceBranch = 'refs/heads/topic/PLT-9221';
            const targetBranch = 'refs/heads/feature/PLT-4873';

            // Execute
            const mergedBranches = mergeBaseBranches(
                originalConfig,
                apiBaseBranch,
            );
            const expression = mergedBranches.join(', ');
            const reviewConfig = processExpression(expression);
            const result = shouldReviewBranches(
                sourceBranch,
                targetBranch,
                reviewConfig,
            );

            // Assert
            expect(mergedBranches).toEqual([
                'develop',
                'feature/*',
                'release/*',
                'refs/heads/master',
            ]);
            expect(expression).toBe(
                'develop, feature/*, release/*, refs/heads/master',
            );
            expect(reviewConfig).toEqual({
                reviewRules: {
                    '*': {
                        'develop': true,
                        'feature/*': true,
                        'release/*': true,
                        'refs/heads/master': true,
                    },
                },
            });
            // Note: This returns false because feature/* doesn't match refs/heads/feature/PLT-4873
            // The wildcard pattern needs to include the refs/heads/ prefix
            expect(result).toBe(false);
        });

        it('should validate branches with wildcards - without refs/heads prefix', () => {
            const originalConfig = ['develop', 'feature/*', 'release/*'];
            const apiBaseBranch = 'master';
            const sourceBranch = 'topic/PLT-9221';
            const targetBranch = 'feature/PLT-4873';

            const mergedBranches = mergeBaseBranches(
                originalConfig,
                apiBaseBranch,
            );
            const expression = mergedBranches.join(', ');
            const reviewConfig = processExpression(expression);
            const result = shouldReviewBranches(
                sourceBranch,
                targetBranch,
                reviewConfig,
            );

            expect(mergedBranches).toEqual([
                'develop',
                'feature/*',
                'release/*',
                'master',
            ]);
            // Now it matches because feature/* matches feature/PLT-4873
            expect(result).toBe(true);
        });

        it('should merge apiBaseBranch with configured branches', () => {
            const originalConfig = ['develop', 'staging'];
            const apiBaseBranch = 'master';
            const sourceBranch = 'feature/test';
            const targetBranch = 'master';

            const mergedBranches = mergeBaseBranches(
                originalConfig,
                apiBaseBranch,
            );
            const expression = mergedBranches.join(', ');
            const reviewConfig = processExpression(expression);
            const result = shouldReviewBranches(
                sourceBranch,
                targetBranch,
                reviewConfig,
            );

            expect(mergedBranches).toContain('develop');
            expect(mergedBranches).toContain('staging');
            expect(mergedBranches).toContain('master');
            expect(result).toBe(true);
        });

        it('should respect exclusion patterns', () => {
            const originalConfig = ['develop', 'feature/*', '!main'];
            const apiBaseBranch = 'develop';
            const sourceBranch = 'feature/test';
            const targetBranch = 'main';

            const mergedBranches = mergeBaseBranches(
                originalConfig,
                apiBaseBranch,
            );
            const expression = mergedBranches.join(', ');
            const reviewConfig = processExpression(expression);
            const result = shouldReviewBranches(
                sourceBranch,
                targetBranch,
                reviewConfig,
            );

            expect(result).toBe(false);
        });

        it('should handle feature branch patterns correctly', () => {
            const originalConfig = ['feature/*', 'develop'];
            const apiBaseBranch = 'develop';
            const sourceBranch = 'feature/xyz-456';
            const targetBranch = 'feature/abc-123';

            const mergedBranches = mergeBaseBranches(
                originalConfig,
                apiBaseBranch,
            );
            const expression = mergedBranches.join(', ');
            const reviewConfig = processExpression(expression);
            const result = shouldReviewBranches(
                sourceBranch,
                targetBranch,
                reviewConfig,
            );

            expect(result).toBe(true);
        });

        it('should add targetBranch to merged branches as fallback when apiBaseBranch not in config', () => {
            const originalConfig = ['develop', 'main'];
            const apiBaseBranch = 'staging'; // Not in originalConfig
            const sourceBranch = 'feature/test';
            const targetBranch = 'staging';

            const mergedBranches = mergeBaseBranches(
                originalConfig,
                apiBaseBranch,
            );
            const expression = mergedBranches.join(', ');
            const reviewConfig = processExpression(expression);
            const result = shouldReviewBranches(
                sourceBranch,
                targetBranch,
                reviewConfig,
            );

            expect(mergedBranches).toContain('develop');
            expect(mergedBranches).toContain('main');
            expect(mergedBranches).toContain('staging');
            expect(result).toBe(true);
        });

        it('should handle multiple wildcard patterns', () => {
            const originalConfig = ['feature/*', 'release/*', 'hotfix/*'];
            const apiBaseBranch = 'develop';
            const sourceBranch = 'feature/new-feature';
            const targetBranch = 'release/v1.0.0';

            const mergedBranches = mergeBaseBranches(
                originalConfig,
                apiBaseBranch,
            );
            const expression = mergedBranches.join(', ');
            const reviewConfig = processExpression(expression);
            const result = shouldReviewBranches(
                sourceBranch,
                targetBranch,
                reviewConfig,
            );

            expect(result).toBe(true);
        });

        it('should validate with exact branch names', () => {
            const originalConfig = ['develop', 'main'];
            const apiBaseBranch = 'develop';
            const sourceBranch = 'feature/test';
            const targetBranch = 'develop';

            const mergedBranches = mergeBaseBranches(
                originalConfig,
                apiBaseBranch,
            );
            const expression = mergedBranches.join(', ');
            const reviewConfig = processExpression(expression);
            const result = shouldReviewBranches(
                sourceBranch,
                targetBranch,
                reviewConfig,
            );

            expect(result).toBe(true);
        });

        it('should not merge if apiBaseBranch is already in configured branches', () => {
            const originalConfig = ['develop', 'main', 'staging'];
            const apiBaseBranch = 'main'; // Already in originalConfig

            const mergedBranches = mergeBaseBranches(
                originalConfig,
                apiBaseBranch,
            );

            expect(mergedBranches).toEqual(['develop', 'main', 'staging']);
            expect(mergedBranches.filter((b) => b === 'main').length).toBe(1);
        });

        it('should not add excluded apiBaseBranch', () => {
            const originalConfig = ['develop', '!main'];
            const apiBaseBranch = 'main';

            const mergedBranches = mergeBaseBranches(
                originalConfig,
                apiBaseBranch,
            );

            // When apiBaseBranch is excluded (!main), it should not be added
            expect(mergedBranches).toContain('develop');
            expect(mergedBranches).toContain('!main');
            // main should not be in the merged branches because it's excluded
            expect(mergedBranches).not.toContain('main');
        });

        it('should handle exclusion pattern correctly in mergeBaseBranches', () => {
            const originalConfig = ['develop', 'feature/*'];
            const apiBaseBranch = 'develop';
            const _sourceBranch = 'hotfix/urgent';
            const _targetBranch = 'main';

            const mergedBranches = mergeBaseBranches(
                originalConfig,
                apiBaseBranch,
            );

            // develop is already in config, so no duplicate
            expect(mergedBranches).toEqual(['develop', 'feature/*']);
        });
    });

    describe('Edge Cases', () => {
        it('should handle refs/heads prefix mismatch gracefully', () => {
            const originalConfig = ['feature/*'];
            const apiBaseBranch = 'main';
            const sourceBranch = 'refs/heads/feature/test';
            const targetBranch = 'refs/heads/feature/target';

            const mergedBranches = mergeBaseBranches(
                originalConfig,
                apiBaseBranch,
            );
            const expression = mergedBranches.join(', ');
            const reviewConfig = processExpression(expression);
            const result = shouldReviewBranches(
                sourceBranch,
                targetBranch,
                reviewConfig,
            );

            // feature/* doesn't match refs/heads/feature/target
            expect(result).toBe(false);
        });

        it('should work when both pattern and branch have refs/heads prefix', () => {
            const originalConfig = ['refs/heads/feature/*'];
            const apiBaseBranch = 'refs/heads/main';
            const sourceBranch = 'refs/heads/topic/test';
            const targetBranch = 'refs/heads/feature/target';

            const mergedBranches = mergeBaseBranches(
                originalConfig,
                apiBaseBranch,
            );
            const expression = mergedBranches.join(', ');
            const reviewConfig = processExpression(expression);
            const result = shouldReviewBranches(
                sourceBranch,
                targetBranch,
                reviewConfig,
            );

            // refs/heads/feature/* should match refs/heads/feature/target
            expect(result).toBe(true);
        });
    });
});
