import axios, { AxiosInstance } from 'axios';

import { MCP_REQUEST_TIMEOUT_MS } from '@libs/core/infrastructure/http/integration-timeouts';

export class AxiosMCPManagerService {
    private axiosInstance: AxiosInstance;

    constructor() {
        this.axiosInstance = axios.create({
            baseURL: process.env.API_KODUS_SERVICE_MCP_MANAGER,
            timeout: MCP_REQUEST_TIMEOUT_MS,
            headers: {
                'Content-Type': 'application/json',
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

    public async delete(url: string, body = {}, config = {}) {
        const { data } = await this.axiosInstance.delete(url, {
            ...config,
            data: body,
        });
        return data;
    }
}
