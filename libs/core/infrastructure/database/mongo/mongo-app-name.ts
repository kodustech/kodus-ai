/**
 * The `appName` every Mongo connection of this process announces to the server.
 *
 * The server records it per operation: `$queryStats` (`key.client.application.name`),
 * `currentOp` and the slow-query log then say which service issued a query,
 * instead of showing every shape as anonymous. Without it a slow aggregation
 * cannot be traced back to the api, the webhook receiver, a worker role, the
 * observability exporter or a script.
 *
 * Dependency-free on purpose: the migration build imports it from `dist/`
 * without the app's DI graph (see mongo-migration-client.ts).
 */
export function mongoAppName(suffix?: string): string {
    const component = process.env.COMPONENT_TYPE || 'default';
    // WORKER_ROLE splits one worker image into code-review, analytics and
    // security-scan processes; any other component has no role.
    const role =
        component === 'worker' ? process.env.WORKER_ROLE?.toLowerCase() : '';

    return ['kodus', component, role, suffix].filter(Boolean).join('-');
}
