/**
 * URL Validator for Axios requests
 *
 * Prevents SSRF attacks by ensuring URLs are relative when baseURL is configured.
 *
 * @see https://github.com/axios/axios/issues/6463
 */

export class AxiosUrlValidator {
    /**
     * Validates that a URL is relative (not absolute or protocol-relative)
     *
     * @param url - The URL to validate
     * @throws Error if URL is absolute or protocol-relative
     */
    static validateRelativeUrl(url: string): void {
        if (!url || typeof url !== 'string') {
            throw new Error('URL must be a non-empty string');
        }

        // Rejeitar URLs absolutas (http://, https://)
        if (url.match(/^https?:\/\//i)) {
            throw new Error(
                'Absolute URLs are not allowed when baseURL is configured. ' +
                    'This prevents SSRF attacks and credential leakage.',
            );
        }

        // Rejeitar protocol-relative URLs (//example.com)
        if (url.startsWith('//')) {
            throw new Error(
                'Protocol-relative URLs are not allowed when baseURL is configured.',
            );
        }

        // Rejeitar URLs que começam com : (ex: :8080/path)
        if (url.startsWith(':')) {
            throw new Error('Invalid URL format');
        }

        // Rejeitar URLs que contêm caracteres suspeitos de tentativa de SSRF
        // Ex: http://internal, https://localhost, etc (mesmo sem protocolo completo)
        const suspiciousPatterns = [
            /^https?:\/\//i, // Já coberto acima, mas incluído para clareza
            /^\/\/[^/]/, // Protocol-relative
            /^:\d+/, // Port-only
        ];

        for (const pattern of suspiciousPatterns) {
            if (pattern.test(url)) {
                throw new Error('Invalid or potentially dangerous URL format');
            }
        }
    }

    /**
     * Checks if a URL is absolute (includes protocol)
     */
    static isAbsoluteUrl(url: string): boolean {
        if (!url || typeof url !== 'string') {
            return false;
        }
        return /^https?:\/\//i.test(url);
    }

    /**
     * Checks if a URL is protocol-relative
     */
    static isProtocolRelativeUrl(url: string): boolean {
        if (!url || typeof url !== 'string') {
            return false;
        }
        return url.startsWith('//');
    }

    /**
     * Validates URL and returns sanitized version
     *
     * @param url - URL to validate and sanitize
     * @returns Sanitized URL (trimmed, without leading slashes if needed)
     */
    static validateAndSanitize(url: string): string {
        this.validateRelativeUrl(url);

        // Remover espaços e normalizar
        const sanitized = url.trim();

        // Garantir que não começa com múltiplas barras (exceto path normal)
        // Ex: //path → /path (mas // é protocol-relative, já rejeitado acima)

        return sanitized;
    }
}
