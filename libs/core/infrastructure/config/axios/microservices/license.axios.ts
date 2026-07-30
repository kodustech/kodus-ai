import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from 'axios';
import { createLogger } from '@libs/core/log/logger';

const DEFAULT_TIMEOUT_MS = 60000; // 60 seconds

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
