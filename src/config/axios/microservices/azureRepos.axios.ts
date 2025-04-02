import axios, { AxiosInstance } from 'axios';

export class AxiosAzureReposService {
    private axiosInstance: AxiosInstance;

    constructor({ tenantId = '', organization = '' }) {
        this.axiosInstance = axios.create({
            baseURL: process.env.KODUS_SERVICE_AZURE_REPOS,
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
