/**
 * Thrown when neither the diff since the last review nor the whole PR could
 * be read (#2268). Not a PR with nothing new, and not a configuration
 * problem: the run has to fail with this message.
 */
export class PullRequestChangesUnreadableError extends Error {
    readonly name = 'PullRequestChangesUnreadableError';

    constructor(
        readonly prNumber: number,
        readonly lastCommitSha?: string,
    ) {
        super(
            `Could not read the changes of PR#${prNumber}: neither the diff since ${lastCommitSha} nor the whole PR was readable`,
        );
    }
}
