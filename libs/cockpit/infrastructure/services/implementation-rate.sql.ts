import { APPLIED_IMPLEMENTATION_STATUSES } from '@libs/platformData/domain/pullRequests/implementation-status';

// The implementation rate's SQL, shared by every Cockpit query that computes it.

/** `IN (...)` of the statuses the rate counts as applied. */
export const APPLIED_SQL = `IN (${APPLIED_IMPLEMENTATION_STATUSES.map((v) => `'${v}'`).join(',')})`;

/**
 * A suggestion no implementation check could decide, and not recorded as
 * applied before: its status says nothing about what the developer did, so a
 * rate leaves it out and counts it apart. COALESCE keeps the expression false,
 * never NULL, for rows without an outcome: under `NOT`, NULL would drop them.
 */
export const undecidedSql = (alias: string) =>
    `(COALESCE(${alias}."suggestionImplementationCheckOutcome", '') = 'unmeasured'
                 AND (${alias}."suggestionImplementationStatus" IS NULL
                      OR ${alias}."suggestionImplementationStatus" NOT ${APPLIED_SQL}))`;
