import axios, { AxiosInstance } from 'axios';

import { INTEGRATION_REQUEST_TIMEOUT_MS } from '@libs/core/infrastructure/http/integration-timeouts';

export class AxiosAzureReposService {
    private axiosInstance: AxiosInstance;

    constructor({ tenantId = '', organization = '' }) {
        this.axiosInstance = axios.create({
            baseURL: process.env.KODUS_SERVICE_AZURE_REPOS,
            // axios default is 0 = infinite. Without this, a stalled
            // upstream microservice would keep the caller's HTTP handler
            // (and its pool connection) hanging until the global undici
            // 10-minute ceiling. Matches the pattern already used in
            // sibling microservice clients (license.axios, mcpManager.axios).
            timeout: INTEGRATION_REQUEST_TIMEOUT_MS,
            headers: {
                'Content-Type': 'application/json',
                'x-tenant-id': tenantId,
                'x-organization': organization,
            },
        });
    }

    // Methods for encapsulating axios calls
    public async get(url: string, config = {}) {
        try {
            const { data } = await this.axiosInstance.get(url, config);
            return data;
        } catch (error) {
            console.log(error);
        }
    }

    public async post(url: string, body = {}, config = {}) {
        const { data } = await this.axiosInstance.post(url, body, config);
        return data;
    }
}
