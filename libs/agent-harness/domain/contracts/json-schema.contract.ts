/**
 * agent-harness — minimal JSON Schema type.
 *
 * The core contracts stay independent of any validation lib (zod, ajv) and
 * of the AI SDK. The infrastructure adapter converts to whatever the model
 * provider needs. Domains may build these from zod via a helper in infra.
 */
export type JSONSchema = {
    type?:
        | 'object'
        | 'array'
        | 'string'
        | 'number'
        | 'integer'
        | 'boolean'
        | 'null';
    properties?: Record<string, JSONSchema>;
    items?: JSONSchema;
    required?: string[];
    enum?: unknown[];
    description?: string;
    [k: string]: unknown;
};
