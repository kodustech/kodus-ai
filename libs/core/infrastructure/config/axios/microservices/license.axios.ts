import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from 'axios';
import { createLogger } from '@libs/core/log/logger';
import {
    BILLING_SIGNATURE_HEADER,
    billingSignatureHeaders,
} from '@libs/common/utils/billing-signature';

const DEFAULT_TIMEOUT_MS = 60000; // 60 seconds

/** Header billing reads on its credit routes — the same one it uses outbound. */
export const SIGNATURE_HEADER = BILLING_SIGNATURE_HEADER;

/** The shared service secret: the dedicated one when set, else the webhook
 *  secret both deployments already hold. */
export function billingServiceSecret(): string {
    return (
        (process.env.API_CREDITS_SERVICE_TOKEN ?? '').trim() ||
        (process.env.API_BILLING_WEBHOOK_SECRET ?? '').trim()
    );
}

export class AxiosLicenseService {
    private readonly axiosInstance: AxiosInstance;
    private readonly logger = createLogger('AxiosLicenseService');

    constructor() {
        this.axiosInstance = axios.create({
            baseURL: `${process.env.GLOBAL_KODUS_SERVICE_BILLING}/api/billing/`,
            headers: {
                'Content-Type': 'application/json',
            },
            timeout: DEFAULT_TIMEOUT_MS,
        });

        // Billing authenticates the callers of its `/credits/*` routes (money)
        // with the SAME shared secret that already signs its outbound webhooks
        // to us (API_BILLING_WEBHOOK_SECRET here,
        // KODUS_NOTIFICATION_WEBHOOK_SECRET there — one value by contract), so
        // enabling this needs no new env var. Signed, not sent: the secret
        // never crosses the wire. An interceptor covers every call site, and
        // routes that do not require it simply ignore the header.
        this.axiosInstance.interceptors.request.use((config) => {
            const secret = billingServiceSecret();
            if (!secret) return config;
            const method = (config.method ?? 'get').toUpperCase();
            // The bytes axios is about to send: it serializes an object body
            // with JSON.stringify, so signing that is signing the wire.
            const rawBody =
                typeof config.data === 'string'
                    ? config.data
                    : config.data === undefined
                      ? ''
                      : JSON.stringify(config.data);
            const url = String(config.url ?? '');
            // Split on the FIRST '?' only, and MERGE: axios appends `params`
            // to whatever query the url already carries, so both end up on the
            // wire and both have to be signed. `params` is also where every
            // credit read puts organizationId, which is the whole reason
            // billing signs the query.
            const q = url.indexOf('?');
            const urlPath = q === -1 ? url : url.slice(0, q);
            const path = `/api/billing/${urlPath.replace(/^\//, '')}`;
            const wireQuery = new URLSearchParams(
                q === -1 ? '' : url.slice(q + 1),
            );
            for (const [key, value] of Object.entries(config.params ?? {})) {
                if (value === undefined || value === null) continue;
                // Arrays: axios's default serializer emits `key[]=a&key[]=b`,
                // so sign the same shape it puts on the wire.
                if (Array.isArray(value)) {
                    for (const item of value) {
                        if (item === undefined || item === null) continue;
                        wireQuery.append(`${key}[]`, String(item));
                    }
                } else {
                    wireQuery.append(key, String(value));
                }
            }
            const query = wireQuery.toString();
            for (const [header, value] of Object.entries(
                billingSignatureHeaders({
                    secret,
                    method,
                    path,
                    query,
                    rawBody,
                }),
            )) {
                config.headers.set(header, value);
            }
            return config;
        });
    }

    private logError(method: string, url: string, error: unknown): void {
        const axiosError = error as AxiosError;

        this.logger.error({
            message: `${method} ${url} failed`,
            context: 'AxiosLicenseService',
            error: axiosError,
            metadata: {
                method,
                url,
                status: axiosError.response?.status,
                statusText: axiosError.response?.statusText,
                responseData: axiosError.response?.data,
                code: axiosError.code,
                baseURL: this.axiosInstance.defaults.baseURL,
            },
        });
    }

    // Methods for encapsulating axios calls
    public async get<T = any>(
        url: string,
        config: AxiosRequestConfig = {},
    ): Promise<T> {
        try {
            const { data } = await this.axiosInstance.get<T>(url, config);
            return data;
        } catch (error) {
            this.logError('GET', url, error);
            throw error;
        }
    }

    public async post<T = any>(
        url: string,
        body: Record<string, unknown> = {},
        config: AxiosRequestConfig = {},
    ): Promise<T> {
        try {
            const { data } = await this.axiosInstance.post<T>(
                url,
                body,
                config,
            );
            return data;
        } catch (error) {
            this.logError('POST', url, error);
            throw error;
        }
    }
}
