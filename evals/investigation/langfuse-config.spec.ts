const { loadLangfuseConfig } = require('./langfuse-config');

function reader(files) {
    return (file) => {
        if (!Object.hasOwn(files, file)) {
            throw new Error(`missing ${file}`);
        }
        return files[file];
    };
}

describe('Langfuse evaluation configuration', () => {
    it('uses explicit environment values ahead of local config files', () => {
        expect(
            loadLangfuseConfig({
                env: {
                    LANGFUSE_PUBLIC_KEY: 'env-public',
                    LANGFUSE_SECRET_KEY: 'env-secret',
                    LANGFUSE_BASE_URL: 'https://env.langfuse.example/',
                },
                paths: ['/config', '/env'],
                readFile: reader({
                    '/config':
                        'LANGFUSE_PUBLIC_KEY=config-public\nLANGFUSE_SECRET_KEY=config-secret',
                }),
            }),
        ).toEqual({
            publicKey: 'env-public',
            secretKey: 'env-secret',
            baseUrl: 'https://env.langfuse.example',
        });
    });

    it('loads quoted and exported values from the shared config or repo .env', () => {
        expect(
            loadLangfuseConfig({
                env: {},
                paths: ['/config', '/env'],
                readFile: reader({
                    '/config': 'export LANGFUSE_PUBLIC_KEY="config-public"\n',
                    '/env': [
                        "LANGFUSE_SECRET_KEY='env-secret' # local only",
                        'LANGFUSE_BASE_URL=https://cloud.langfuse.com/',
                    ].join('\n'),
                }),
            }),
        ).toEqual({
            publicKey: 'config-public',
            secretKey: 'env-secret',
            baseUrl: 'https://cloud.langfuse.com',
        });
    });

    it('leaves missing credentials explicit instead of fabricating an Authorization header', () => {
        expect(
            loadLangfuseConfig({
                env: {},
                paths: ['/missing'],
                readFile: reader({}),
            }),
        ).toEqual({
            publicKey: null,
            secretKey: null,
            baseUrl: 'https://us.cloud.langfuse.com',
        });
    });
});
