import {
    processExpression,
    shouldReviewBranches,
} from '@/core/infrastructure/adapters/services/codeBase/branchReview.service';

describe('processExpression - Unit Tests', () => {
    describe('Basic Patterns', () => {
        it('should process simple branch names', () => {
            const expression = 'develop, main, staging';
            const result = processExpression(expression);

            expect(result).toEqual({
                reviewRules: {
                    '*': {
                        develop: true,
                        main: true,
                        staging: true,
                    },
                },
            });
        });

        it('should process wildcard patterns', () => {
            const expression = 'feature/*, release/*, hotfix/*';
            const result = processExpression(expression);

            expect(result).toEqual({
                reviewRules: {
                    '*': {
                        'feature/*': true,
                        'release/*': true,
                        'hotfix/*': true,
                    },
                },
            });
        });

        it('should process exclusion patterns', () => {
            const expression = '!main, !production';
            const result = processExpression(expression);

            expect(result).toEqual({
                reviewRules: {
                    '*': {
                        '!main': false,
                        '!production': false,
                    },
                },
            });
        });

        it('should process exact match patterns with =', () => {
            const expression = '=develop, =main';
            const result = processExpression(expression);

            expect(result).toEqual({
                reviewRules: {
                    '*': {
                        develop: true,
                        main: true,
                    },
                },
            });
        });

        it('should keep a !== rule as an exclusion keyed by its raw text', () => {
            const result = processExpression('=main, !==develop');

            expect(result).toEqual({
                reviewRules: {
                    '*': {
                        'main': true,
                        '!==develop': false,
                    },
                },
            });
        });

        it('should process contains patterns', () => {
            const expression = 'contains:demo, contains:test';
            const result = processExpression(expression);

            expect(result).toEqual({
                reviewRules: {
                    'contains:demo': { '*': true },
                    'contains:test': { '*': true },
                },
            });
        });
    });

    describe('Mixed Patterns', () => {
        it('should process mixed inclusion and exclusion patterns', () => {
            const expression = 'develop, feature/*, !main, release/*';
            const result = processExpression(expression);

            expect(result).toEqual({
                reviewRules: {
                    '*': {
                        'develop': true,
                        'feature/*': true,
                        '!main': false,
                        'release/*': true,
                    },
                },
            });
        });

        it('should handle expression from test.json', () => {
            const expression =
                'develop, feature/*, release/*, refs/heads/master';
            const result = processExpression(expression);

            expect(result).toEqual({
                reviewRules: {
                    '*': {
                        'develop': true,
                        'feature/*': true,
                        'release/*': true,
                        'refs/heads/master': true,
                    },
                },
            });
        });
    });

    describe('Edge Cases', () => {
        it('should return empty rules for empty expression', () => {
            const result = processExpression('');
            expect(result).toEqual({ reviewRules: {} });
        });

        it('should return empty rules for whitespace-only expression', () => {
            const result = processExpression('   ');
            expect(result).toEqual({ reviewRules: {} });
        });

        it('should trim whitespace from patterns', () => {
            const expression = '  develop  ,  feature/*  ,  main  ';
            const result = processExpression(expression);

            expect(result).toEqual({
                reviewRules: {
                    '*': {
                        'develop': true,
                        'feature/*': true,
                        'main': true,
                    },
                },
            });
        });

        it('should handle single pattern without commas', () => {
            const expression = 'develop';
            const result = processExpression(expression);

            expect(result).toEqual({
                reviewRules: {
                    '*': {
                        develop: true,
                    },
                },
            });
        });

        it('should handle refs/heads/ prefix in patterns', () => {
            const expression = 'refs/heads/main, refs/heads/feature/*';
            const result = processExpression(expression);

            expect(result).toEqual({
                reviewRules: {
                    '*': {
                        'refs/heads/main': true,
                        'refs/heads/feature/*': true,
                    },
                },
            });
        });
    });
});

describe('shouldReviewBranches - Unit Tests', () => {
    describe('Exact Match Scenarios', () => {
        it('should match exact branch names', () => {
            const config = {
                reviewRules: {
                    '*': {
                        develop: true,
                        main: true,
                    },
                },
            };

            expect(
                shouldReviewBranches('feature/test', 'develop', config),
            ).toBe(true);
            expect(shouldReviewBranches('feature/test', 'main', config)).toBe(
                true,
            );
            expect(
                shouldReviewBranches('feature/test', 'staging', config),
            ).toBe(false);
        });

        it('should respect source branch patterns', () => {
            const config = {
                reviewRules: {
                    'feature/*': {
                        develop: true,
                    },
                },
            };

            expect(shouldReviewBranches('feature/new', 'develop', config)).toBe(
                true,
            );
            expect(shouldReviewBranches('hotfix/bug', 'develop', config)).toBe(
                false,
            );
        });
    });

    describe('Wildcard Pattern Scenarios', () => {
        it('should match wildcard patterns in target', () => {
            const config = {
                reviewRules: {
                    '*': {
                        'feature/*': true,
                    },
                },
            };

            expect(shouldReviewBranches('develop', 'feature/abc', config)).toBe(
                true,
            );
            expect(shouldReviewBranches('develop', 'feature/xyz', config)).toBe(
                true,
            );
            expect(shouldReviewBranches('develop', 'feature/', config)).toBe(
                true,
            );
            expect(shouldReviewBranches('develop', 'main', config)).toBe(false);
        });

        it('should match wildcard patterns in source', () => {
            const config = {
                reviewRules: {
                    'feature/*': {
                        '*': true,
                    },
                },
            };

            expect(
                shouldReviewBranches('feature/test', 'develop', config),
            ).toBe(true);
            expect(shouldReviewBranches('feature/test', 'main', config)).toBe(
                true,
            );
            expect(shouldReviewBranches('hotfix/bug', 'develop', config)).toBe(
                false,
            );
        });
    });

    describe('Exclusion Pattern Scenarios', () => {
        it('should respect exclusion patterns', () => {
            const config = {
                reviewRules: {
                    '*': {
                        'develop': true,
                        'feature/*': true,
                        '!main': false,
                    },
                },
            };

            expect(
                shouldReviewBranches('feature/test', 'develop', config),
            ).toBe(true);
            expect(
                shouldReviewBranches('feature/test', 'feature/abc', config),
            ).toBe(true);
            expect(shouldReviewBranches('feature/test', 'main', config)).toBe(
                false,
            );
        });

        it('should prioritize exclusions over inclusions', () => {
            const config = {
                reviewRules: {
                    '*': {
                        'feature/*': true, // Include all feature branches
                        '!feature/test': false, // But exclude feature/test
                    },
                },
            };

            expect(shouldReviewBranches('develop', 'feature/abc', config)).toBe(
                true,
            );
            expect(
                shouldReviewBranches('develop', 'feature/test', config),
            ).toBe(false);
        });

        it('should handle wildcard exclusions', () => {
            const config = {
                reviewRules: {
                    '*': {
                        'feature/*': true,
                        '!feature/experimental-*': false,
                    },
                },
            };

            expect(shouldReviewBranches('develop', 'feature/new', config)).toBe(
                true,
            );
            expect(
                shouldReviewBranches(
                    'develop',
                    'feature/experimental-ai',
                    config,
                ),
            ).toBe(false);
            expect(
                shouldReviewBranches(
                    'develop',
                    'feature/experimental-test',
                    config,
                ),
            ).toBe(false);
        });
    });

    describe('Contains Pattern Scenarios', () => {
        it('should match contains patterns', () => {
            const config = {
                reviewRules: {
                    'contains:demo': {
                        '*': true,
                    },
                },
            };

            expect(
                shouldReviewBranches('feature/demo-test', 'develop', config),
            ).toBe(true);
            expect(shouldReviewBranches('demo-branch', 'develop', config)).toBe(
                true,
            );
            expect(shouldReviewBranches('test-demo', 'develop', config)).toBe(
                true,
            );
            expect(
                shouldReviewBranches('feature/test', 'develop', config),
            ).toBe(false);
        });
    });

    describe('Priority and Specificity', () => {
        it('should prioritize more specific rules', () => {
            const config = {
                reviewRules: {
                    '*': {
                        '*': true, // Default: allow all
                        '!main': false, // But exclude main
                    },
                    'feature/*': {
                        '*': true, // Feature branches can go anywhere
                    },
                },
            };

            // Feature branch to main should be blocked by exclusion (higher priority)
            expect(shouldReviewBranches('feature/test', 'main', config)).toBe(
                false,
            );

            // Feature branch to develop should be allowed
            expect(
                shouldReviewBranches('feature/test', 'develop', config),
            ).toBe(true);
        });
    });

    describe('Real-World Scenarios from test.json', () => {
        it('should handle the exact scenario from test.json', () => {
            // Expression: "develop, feature/*, release/*, refs/heads/master"
            const config = {
                reviewRules: {
                    '*': {
                        'develop': true,
                        'feature/*': true,
                        'release/*': true,
                        'refs/heads/master': true,
                    },
                },
            };

            const sourceBranch = 'refs/heads/topic/PLT-9221';
            const targetBranch = 'refs/heads/feature/PLT-4873';

            const result = shouldReviewBranches(
                sourceBranch,
                targetBranch,
                config,
            );

            // Returns false because feature/* doesn't match refs/heads/feature/PLT-4873
            // The pattern would need to be refs/heads/feature/* to match
            expect(result).toBe(false);
        });

        it('should work when pattern includes refs/heads prefix', () => {
            const config = {
                reviewRules: {
                    '*': {
                        'refs/heads/develop': true,
                        'refs/heads/feature/*': true,
                        'refs/heads/release/*': true,
                        'refs/heads/master': true,
                    },
                },
            };

            const sourceBranch = 'refs/heads/topic/PLT-9221';
            const targetBranch = 'refs/heads/feature/PLT-4873';

            const result = shouldReviewBranches(
                sourceBranch,
                targetBranch,
                config,
            );

            // Now it matches because refs/heads/feature/* matches refs/heads/feature/PLT-4873
            expect(result).toBe(true);
        });
    });

    describe('Edge Cases', () => {
        it('should return false for empty config', () => {
            const result = shouldReviewBranches('feature/test', 'develop', {
                reviewRules: {},
            });
            expect(result).toBe(false);
        });

        it('should return false for null branches', () => {
            const config = {
                reviewRules: {
                    '*': { '*': true },
                },
            };

            expect(shouldReviewBranches(null as any, 'develop', config)).toBe(
                false,
            );
            expect(
                shouldReviewBranches('feature/test', null as any, config),
            ).toBe(false);
            expect(shouldReviewBranches(null as any, null as any, config)).toBe(
                false,
            );
        });

        it('should return false for undefined branches', () => {
            const config = {
                reviewRules: {
                    '*': { '*': true },
                },
            };

            expect(
                shouldReviewBranches(undefined as any, 'develop', config),
            ).toBe(false);
            expect(
                shouldReviewBranches('feature/test', undefined as any, config),
            ).toBe(false);
        });

        it('should return false for empty string branches', () => {
            const config = {
                reviewRules: {
                    '*': { '*': true },
                },
            };

            expect(shouldReviewBranches('', 'develop', config)).toBe(false);
            expect(shouldReviewBranches('feature/test', '', config)).toBe(
                false,
            );
        });

        it('should return false for an invalid regex pattern instead of throwing', () => {
            const result = shouldReviewBranches('feature/xyz', 'develop', {
                reviewRules: {
                    'invalid[pattern': { '*': true },
                },
            });
            expect(result).toBe(false);
        });

        it('should return false for config without reviewRules', () => {
            const result = shouldReviewBranches(
                'feature/test',
                'develop',
                {} as any,
            );
            expect(result).toBe(false);
        });
    });
});
