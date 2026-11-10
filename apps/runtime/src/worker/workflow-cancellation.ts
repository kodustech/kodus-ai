/**
 * Workflow control errors reach DBOS untouched. A stale owner cannot finalize or
 * release the current owner's claims. Keep this name for existing callers.
 */
export const isCancellation = (error: unknown) => {
    const names = [(error as Error)?.name, (error as { constructor?: { name?: string } })?.constructor?.name];
    return names.some((name) => /Cancel/.test(name ?? '') || name === 'DBOSWorkflowConflictError');
};
