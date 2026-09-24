/**
 * Greppable log markers for the LLM surface. One `grep` per concern:
 *   - `[LLM-ERROR]`   every LLM call / config-test that FAILED
 *   - `[LLM-SUCCESS]` every LLM call / config-test that SUCCEEDED
 *   - `[LLM_ENVELOPE]` off-schema output-shape recovery / degradation (#1786),
 *      defined in structured-output-repair.ts where the recovery lives.
 *
 * Keep the literals stable — dashboards and log filters are built on them.
 */
export const LLM_ERROR_TAG = '[LLM-ERROR]';
export const LLM_SUCCESS_TAG = '[LLM-SUCCESS]';

/** Off-schema output-shape recovery / degradation (#1786). Consumed at the
 *  normalize call-sites and the parse boundaries that log a give-up. */
export const LLM_ENVELOPE_TAG = '[LLM_ENVELOPE]';
