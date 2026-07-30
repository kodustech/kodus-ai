import { SpanProcessor, TraceItem } from '../types';

export type RedactionStyle = 'full' | 'partial';

/**
 * Processor to redact sensitive information from traces before export.
 * Based on best practices from Mastra observability.
 */
export class SanitizationProcessor implements SpanProcessor {
    private sensitiveKeys: Set<string>;
    private redactionToken = '[REDACTED]';
    private redactionStyle: RedactionStyle;

    constructor(
        config: {
            sensitiveKeys?: string[];
            redactionToken?: string;
            redactionStyle?: RedactionStyle;
        } = {},
    ) {
        // Default sensitive keys (normalized)
        this.sensitiveKeys = new Set([
            'password',
            'token',
            'apikey',
            'api_key',
            'secret',
            'authorization',
            'bearer',
            'creditcard',
            'cvv',
            'ssn',
            'cpf',
            'clientsecret',
            'privatekey',
            'refresh',
            'auth',
            'bearertoken',
            'jwt',
            'credential',
            ...(config.sensitiveKeys || []).map((k) => this.normalizeKey(k)),
        ]);

        if (config.redactionToken) {
            this.redactionToken = config.redactionToken;
        }
        this.redactionStyle = config.redactionStyle || 'full';
    }

    async process(item: TraceItem): Promise<void> {
        item.attributes = this.tryFilter(item.attributes);
        // Assuming TraceItem might evolve to have input/output like in Mastra/Kodus
        if ((item as any).input) {
            (item as any).input = this.tryFilter((item as any).input);
        }
        if ((item as any).output) {
            (item as any).output = this.tryFilter((item as any).output);
        }
    }

    private tryFilter(value: any): any {
        try {
            return this.deepFilter(value);
        } catch {
            return { error: { processor: 'SanitizationProcessor' } };
        }
    }

    /**
     * Recursively filter objects/arrays for sensitive keys.
     * Handles circular references by replacing with a marker.
     * Also attempts to parse and redact JSON strings.
     */
    private deepFilter(obj: any, seen = new WeakSet()): any {
        if (obj === null || typeof obj !== 'object') {
            // Handle string values - check if they contain JSON that needs redacting
            if (typeof obj === 'string') {
                const trimmed = obj.trim();
                // Quick check - JSON objects/arrays start with { or [
                if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                    return this.redactJsonString(obj);
                }
            }
            return obj;
        }

        if (seen.has(obj)) {
            return '[Circular Reference]';
        }
        seen.add(obj);

        if (Array.isArray(obj)) {
            return obj.map((item) => this.deepFilter(item, seen));
        }

        const filtered: any = {};
        for (const key of Object.keys(obj)) {
            const normKey = this.normalizeKey(key);

            if (this.isSensitive(normKey)) {
                if (obj[key] && typeof obj[key] === 'object') {
                    // Even if key is sensitive, if value is complex, drill down?
                    // Mastra logic: if key is sensitive, redact value.
                    // But if it's an object, maybe we want to redact deeper or just wipe it.
                    // Mastra implementation: if obj, recurse; else redact value.
                    // Wait, looking at Mastra code again:
                    // if (this.isSensitive(normKey)) {
                    //   if (obj[key] && typeof obj[key] === 'object') {
                    //      filtered[key] = this.deepFilter(obj[key], seen); // Mistake in my thought? No.
                    //      // Actually Mastra logic was:
                    //      // if object -> deepFilter (recurse to find keys inside sensitive object?)
                    //      // else -> redactValue
                    //      // Wait, if key is 'user', and user has 'password', we want to redact 'password'.
                    //      // If key is 'password', and value is object (unlikely?), we redact it.
                    //
                    // Let's re-read Mastra logic:
                    // if (this.isSensitive(normKey)) {
                    //   if (obj[key] && typeof obj[key] === 'object') {
                    //     filtered[key] = this.deepFilter(obj[key], seen);
                    //   } else {
                    //     filtered[key] = this.redactValue(obj[key]);
                    //   }
                    // } else {
                    //   filtered[key] = this.deepFilter(obj[key], seen);
                    // }
                    // This implies if key is sensitive (e.g. "secretData"), but value is object, we DON'T redact the whole object, we look inside?
                    // Or maybe it assumes if it's an object it's a structural container.
                    // Let's assume sensitive keys usually point to primitive values.

                    if (obj[key] && typeof obj[key] === 'object') {
                        filtered[key] = this.deepFilter(obj[key], seen);
                    } else {
                        filtered[key] = this.redactValue(obj[key]);
                    }
                } else {
                    filtered[key] = this.redactValue(obj[key]);
                }
            } else {
                filtered[key] = this.deepFilter(obj[key], seen);
            }
        }

        return filtered;
    }

    private normalizeKey(key: string): string {
        return key.toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    private isSensitive(normalizedKey: string): boolean {
        // Exact match on normalized key
        return this.sensitiveKeys.has(normalizedKey);
    }

    private redactValue(value: any): string {
        if (this.redactionStyle === 'full') {
            return this.redactionToken;
        }

        const str = String(value);
        const len = str.length;
        if (len <= 6) {
            return this.redactionToken; // too short, redact fully
        }
        return str.slice(0, 3) + '...' + str.slice(len - 3);
    }

    private redactJsonString(str: string): string {
        try {
            const parsed = JSON.parse(str);
            if (parsed && typeof parsed === 'object') {
                const filtered = this.deepFilter(parsed, new WeakSet());
                return JSON.stringify(filtered);
            }
            return str;
        } catch {
            return str;
        }
    }

    async flush(): Promise<void> {
        // No-op
    }

    async shutdown(): Promise<void> {
        // No-op
    }
}
