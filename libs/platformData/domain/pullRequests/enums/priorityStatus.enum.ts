export enum PriorityStatus {
    PRIORITIZED = 'prioritized',
    PRIORITIZED_BY_CLUSTERING = 'prioritized-by-clustering',
    REPRIORIZED = 'repriorized',
    DISCARDED_BY_SEVERITY = 'discarded-by-severity',
    DISCARDED_BY_QUANTITY = 'discarded-by-quantity',
    DISCARDED_BY_CLUSTERING = 'discarded-by-clustering',
    DISCARDED_BY_SAFEGUARD = 'discarded-by-safeguard',
    DISCARDED_BY_CODE_DIFF = 'discarded-by-code-diff',
    DISCARDED_BY_KODY_FINE_TUNING = 'discarded-by-kody-fine-tuning',
    /** An earlier comment on the same PR already raised it (#2097). */
    DISCARDED_BY_REPEAT = 'discarded-by-repeat',
    /** Its verify run failed, so nobody judged it (#2171). */
    DISCARDED_BY_VERIFY_ERROR = 'discarded-by-verify-error',
    /** Its label is a category the team turned off (#1821). */
    DISCARDED_BY_CATEGORY = 'discarded-by-category',
}
