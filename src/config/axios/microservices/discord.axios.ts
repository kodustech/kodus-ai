import axios, { AxiosInstance } from 'axios';

export class AxiosDiscordService {
    private axiosInstance: AxiosInstance;

    constructor() {
        this.axiosInstance = axios.create({
            baseURL: process.env.GLOBAL_KODUS_SERVICE_DISCORD,
            headers: {
                'Content-Type': 'application/json',
            },
        });

        // Interceptor config
        this.setupInterceptors();
    }

    private setupInterceptors() {
        this.axiosInstance.interceptors.request.use((config) => {
            // Modify requests here
            return config;
        });

        this.axiosInstance.interceptors.response.use(
            (response) => {
                // Modify responses here
                return response;
            },
            (error) => {
                // Error handling
                return Promise.reject(error);
            },
        );
    }

    // Methods for encapsulating axios calls
    public get(url: string, config = {}) {
        return this.axiosInstance.get(url, config);
    }

    public post(url: string, data = {}, config = {}) {
        return this.axiosInstance.post(url, data, config);
    }
}
