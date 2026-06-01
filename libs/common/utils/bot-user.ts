/**
 * Login/username substrings that identify automation accounts whose
 * "actions" should never trigger user-facing notifications. We deliberately
 * over-match (substring, case-insensitive) so a slightly different vendor
 * variant — `dependabot[bot]`, `dependabot-preview[bot]`, etc. — still
 * filters out.
 */
const BOT_LOGIN_FRAGMENTS: ReadonlyArray<string> = [
    '[bot]',
    'dependabot',
    'renovate',
    'renovatebot',
    'github-actions',
    'gitlab-bot',
    'kodus-bot',
    'mergify',
];

/**
 * True when the given platform login (GitHub `dependabot[bot]`,
 * GitLab `gitlab-bot`, Bitbucket app IDs, etc.) looks like a bot.
 * Caller-side filter for notification emits whose audience is "the PR
 * author" — bots are excluded.
 *
 * Falsy input returns false; nothing to filter when there's no login.
 */
export function isBotUser(login: string | null | undefined): boolean {
    if (!login) return false;
    const normalized = login.toLowerCase();
    return BOT_LOGIN_FRAGMENTS.some((fragment) =>
        normalized.includes(fragment),
    );
}
