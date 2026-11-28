/** Keys an exception already owns: context never overwrites them. */
type OwnErrorKey = 'name' | 'message' | 'stack' | 'cause' | 'response' | 'status' | 'options';

/** Ids, kinds and counts that say which call failed and how; never a token, a prompt or a body. */
export type FailureContext = { [key: string]: string | number | boolean | undefined } & { [K in OwnErrorKey]?: never };

/**
 * A failure a Runtime API route throws is logged once, by the API's exception
 * filter (`ExceptionsFilter` in libs/core), which logs every exception a route
 * throws with the exception's own scalar fields and its cause's message and
 * stack. A use case that fails or refuses a call therefore does not log it
 * too: it puts what only it knows on the exception with this, and throws.
 */
export function withFailureContext<E extends Error>(error: E, context: FailureContext, cause?: unknown): E {
    const fields = error as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(context)) if (value !== undefined) fields[key] = value;
    // Set on the instance, not through Nest's `options`: the filter's serializer would copy `options` whole.
    if (cause !== undefined) error.cause = cause;
    return error;
}

/** The name of what a call threw, for a failure whose message may carry request details. */
export const errorNameOf = (e: unknown): string => (e instanceof Error ? e.name : typeof e);
