describe('version route', () => {
    const originalFetch = global.fetch;
    const originalReleaseVersion = process.env.RELEASE_VERSION;

    beforeEach(() => {
        process.env.RELEASE_VERSION = '1.2.3';
    });

    afterEach(() => {
        global.fetch = originalFetch;
        process.env.RELEASE_VERSION = originalReleaseVersion;
        jest.restoreAllMocks();
    });

    it('returns latest null when GitHub response has no tag_name', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({ name: 'latest' }),
        } as any);

        const { GET } = await import('./route');
        const response = await GET();
        const payload = await response.json();

        expect(payload).toEqual({
            current: '1.2.3',
            latest: null,
            hasUpdate: false,
        });
    });

    it('reports updates when GitHub returns a newer tag_name', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({ tag_name: 'v1.2.4' }),
        } as any);

        const { GET } = await import('./route');
        const response = await GET();
        const payload = await response.json();

        expect(payload).toEqual({
            current: '1.2.3',
            latest: '1.2.4',
            hasUpdate: true,
        });
    });
});
