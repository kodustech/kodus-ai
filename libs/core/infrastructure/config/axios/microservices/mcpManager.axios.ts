import axios, { AxiosInstance } from 'axios';

export class AxiosMCPManagerService {
    private axiosInstance: AxiosInstance;

    constructor() {
        this.axiosInstance = axios.create({
            baseURL: process.env.API_KODUS_SERVICE_MCP_MANAGER,
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
