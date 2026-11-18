/**
 * The organization's active integrations do not list the repository.
 *
 * This is a normal state, not a fault: a repository removed from the
 * integration keeps its Kody Rules and settings until something cleans them
 * up, and that cleanup still refers to the repository by id.
 */
export class RepositoryNotIntegratedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RepositoryNotIntegratedError';
    }
}
