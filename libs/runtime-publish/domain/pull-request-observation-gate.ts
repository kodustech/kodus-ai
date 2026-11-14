// Which pull request events the webhook handler records for the Runtime
// trigger. Without a Runtime environment on the repository the trigger skips
// every event (no_environment), and no Run can be live to cancel, so the
// event is not written at all: repos that do not use the Runtime cost nothing.

export const RUNTIME_PULL_REQUEST_GATE_TOKEN = Symbol.for('RuntimePullRequestGate');

export interface RuntimePullRequestGate {
    shouldRecord(input: { organizationId: string; repositoryId: string }): Promise<boolean>;
}
