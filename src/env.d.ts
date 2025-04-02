declare global {
    namespace NodeJS {
        interface ProcessEnv {
            // ENVIRONMENT
            API_NODE_ENV: string;
            ENV?: 'development' | 'production';

            // SERVER
            API_HOST: string;
            API_PORT: string;

            API_RATE_MAX_REQUEST?: string;
            API_RATE_INTERVAL?: string;

            // JWT
            API_JWT_SECRET: string;
            API_JWT_EXPIRES_IN: string;
            API_JWT_REFRESH_SECRET: string;
            API_JWT_REFRESH_EXPIRES_IN: string;

            // Database
            DB_HOST: string;
            DB_PORT?: string;
            DB_USERNAME?: string;
            DB_PASSWORD?: string;
            DB_DATABASE: string;

            S3_ACCESS_KEY_ID: string;
            S3_SECRET_ACCESS_KEY: string;
            S3_BUCKET: string;
            S3_ENDPOINT: string;

            // JIRA
            GLOBAL_JIRA_CLIENT_ID: string;
            GLOBAL_JIRA_REDIRECT_URI: string;
            API_JIRA_CLIENT_SECRET: string;
            API_JIRA_BASE_URL: string;
            API_JIRA_MID_URL: string;
            API_JIRA_OAUTH_TOKEN_URL: string;
            API_JIRA_OAUTH_API_TOKEN_URL: string;
            API_JIRA_GET_PERSONAL_PROFILE_URL: string;

            // GITHUB
            GLOBAL_GITHUB_CLIENT_ID: string;
            API_GITHUB_CLIENT_SECRET: string;
            GLOBAL_GITHUB_REDIRECT_URI: string;

            // LANGCHAIN
            LANGCHAIN_TRACING_V2: boolean;
            LANGCHAIN_ENDPOINT: string;
            LANGCHAIN_API_KEY: string;
            LANGCHAIN_PROJECT: string;
        }
    }
}

export {};
