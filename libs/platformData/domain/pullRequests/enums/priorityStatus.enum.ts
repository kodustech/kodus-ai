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
    /** The pipeline re-read the whole PR after an orphaned base commit
     *  (rebase/force-push) and this suggestion's file is byte-identical to
     *  the previously-reviewed head, so that code was already reviewed
     *  (#2037). */
    DISCARDED_BY_UNCHANGED_CODE = 'discarded-by-unchanged-code',
}
