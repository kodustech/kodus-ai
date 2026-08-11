import type { NormalizedCommandError } from '../../utils/command-errors.js';

export function buildReviewErrorHints(
    error: NormalizedCommandError,
): string[] {
    switch (error.code) {
        case 'AUTH_REQUIRED':
            return [
                'Run `kodus auth login` to use your account or `kodus auth team-key --key <your-key>` to use a team key.',
            ];
        case 'API_REQUEST_FAILED':
            if (error.details?.statusCode === 403) {
                return [
                    'The API denied the request (403). On large reviews this is usually a request-size limit enforced in front of the API — narrow the scope or use `--branch`, `--commit`, or `--fast` (which avoid inlining file contents). Run with `-v` for more detail.',
                ];
            }
            if (error.details?.statusCode === 413) {
                return [
                    'The request exceeded the API payload size limit. Narrow the review scope or use `--branch`, `--commit`, or `--fast`.',
                ];
            }
            if (error.message.includes('Could not reach the Kodus API')) {
                return [
                    'Check `KODUS_API_URL` and make sure the Kodus API is running if you are testing locally.',
                ];
            }
            return [];
        case 'REVIEW_TOO_LARGE':
            return [
                'The review is larger than the API accepts. Narrow the scope (e.g. pass specific files) or use `--branch`, `--commit`, or `--fast`, which avoid inlining file contents.',
            ];
        case 'NOT_IN_GIT_REPO':
            return [
                'Run `kodus review` inside a Git repository, or pass explicit file paths to review.',
            ];
        case 'INVALID_INPUT':
            return [
                'Run `kodus review --help` to see supported options, examples, and valid flag combinations.',
            ];
        default:
            return [];
    }
}
