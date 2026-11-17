/**
 * One-shot fix for Kody Rules stored with a misspelled pull-request scope.
 *
 * The CLI sent `scope: 'pull request'` (with a space) and the /cli/kody-rules
 * endpoint stored it unvalidated, but the review pipeline only matches
 * `KodyRulesScope.PULL_REQUEST` (`'pull-request'`), so those rules were judged
 * as file rules (kody-rules-agent.provider.ts). This rewrites the misspellings
 * over the embedded `rules[]` of every `kodyRules` document to the canonical
 * value. Rules with any other scope are left as-is.
 *
 * Idempotent: a rule already on `'pull-request'` does not match.
 *
 * Dependency-free (only the `mongodb` driver) so it can be imported by both a
 * TypeORM migration (the boot path, recorded in the Postgres migrations table)
 * and the standalone runner (`pnpm mongo:migrate`). See mongo-migration-client.
 */
import { Db } from 'mongodb';

export const CANONICAL_PULL_REQUEST_SCOPE = 'pull-request';

// Spellings the CLI accepted and stored before it normalized its input.
export const LEGACY_PULL_REQUEST_SCOPES = ['pull request', 'pull_request'];

export type NormalizePullRequestScopeOptions = {
    dryRun?: boolean;
    log?: (msg: string) => void;
};

export type NormalizePullRequestScopeResult = {
    docsUpdated: number;
    rulesMigrated: number;
};

export async function normalizeKodyRulesPullRequestScope(
    db: Db,
    opts: NormalizePullRequestScopeOptions = {},
): Promise<NormalizePullRequestScopeResult> {
    const dryRun = opts.dryRun ?? false;
    const log = opts.log ?? (() => {});
    const collection = db.collection('kodyRules');
    const legacy = { $in: LEGACY_PULL_REQUEST_SCOPES };

    const [counts] = await collection
        .aggregate<{ docs: number; rules: number }>([
            { $match: { 'rules.scope': legacy } },
            {
                $project: {
                    rules: {
                        $size: {
                            $filter: {
                                input: '$rules',
                                as: 'rule',
                                cond: {
                                    $in: [
                                        '$$rule.scope',
                                        LEGACY_PULL_REQUEST_SCOPES,
                                    ],
                                },
                            },
                        },
                    },
                },
            },
            {
                $group: {
                    _id: null,
                    docs: { $sum: 1 },
                    rules: { $sum: '$rules' },
                },
            },
        ])
        .toArray();

    const docsUpdated = counts?.docs ?? 0;
    const rulesMigrated = counts?.rules ?? 0;

    if (!dryRun && docsUpdated > 0) {
        await collection.updateMany(
            { 'rules.scope': legacy },
            { $set: { 'rules.$[rule].scope': CANONICAL_PULL_REQUEST_SCOPE } },
            { arrayFilters: [{ 'rule.scope': legacy }] },
        );
    }

    log(
        `[normalize-kody-rules-pr-scope]${dryRun ? ' [DRY RUN]' : ''} ` +
            `${docsUpdated} org doc(s) ${dryRun ? 'would be ' : ''}updated; ` +
            `${rulesMigrated} rule(s) set to '${CANONICAL_PULL_REQUEST_SCOPE}'.`,
    );

    return { docsUpdated, rulesMigrated };
}
