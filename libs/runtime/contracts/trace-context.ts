import { z } from 'zod';

/**
 * W3C trace context (https://www.w3.org/TR/trace-context/), version 00: the
 * traceparent a product request, a Runtime command and a cell frame may carry
 * so the Run is one trace from the webhook to the cell (docs/runtime/observability.md).
 * A trace or parent id of all zeros is invalid.
 */
export const TRACEPARENT = /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-0[01]$/;

/**
 * The same shape without the all-zero rule, for the JSON Schema the Go cell
 * validates with (RE2 has no lookahead): the zero ids are refused by the
 * refinement here and by the same check in internal/protocol/codec.go.
 */
export const TRACEPARENT_SHAPE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/;

export const isValidTraceparent = (v: string): boolean => TRACEPARENT.test(v);

export const TraceparentSchema = z.string().regex(TRACEPARENT_SHAPE).refine(isValidTraceparent, { message: 'traceparent: an all-zero trace or parent id is invalid' });
