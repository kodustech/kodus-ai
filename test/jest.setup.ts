if (!process.env.API_CRYPTO_KEY) {
    process.env.API_CRYPTO_KEY =
        '0000000000000000000000000000000000000000000000000000000000000000';
}

if (!process.env.CODE_MANAGEMENT_SECRET) {
    process.env.CODE_MANAGEMENT_SECRET =
        '0000000000000000000000000000000000000000000000000000000000000000';
}

if (!process.env.CODE_MANAGEMENT_WEBHOOK_TOKEN) {
    process.env.CODE_MANAGEMENT_WEBHOOK_TOKEN = 'test-webhook-token';
}

if (!process.env.API_LOG_LEVEL) {
    process.env.API_LOG_LEVEL = 'error';
}

// Mock logger globally to silence logs during tests
jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));
