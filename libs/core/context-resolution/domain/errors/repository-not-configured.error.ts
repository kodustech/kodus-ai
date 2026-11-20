/**
 * The repository is in the integration but has no entry in the team's code
 * review config.
 *
 * Like a repository that left the integration, this is a state, not a fault:
 * nothing more than the id can be said about it.
 */
export class RepositoryNotConfiguredError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RepositoryNotConfiguredError';
    }
}
