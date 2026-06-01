describe("version route", () => {
    const originalFetch = global.fetch;
    const originalReleaseVersion = process.env.RELEASE_VERSION;
    const originalNodeEnv = process.env.WEB_NODE_ENV;

    beforeEach(() => {
        process.env.RELEASE_VERSION = "1.2.3";
        process.env.WEB_NODE_ENV = "self-hosted";
    });

    afterEach(() => {
        global.fetch = originalFetch;
        process.env.RELEASE_VERSION = originalReleaseVersion;
        process.env.WEB_NODE_ENV = originalNodeEnv;
        jest.restoreAllMocks();
        jest.resetModules();
    });

    const mockReleases = (releases: unknown) => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(releases),
        } as any);
    };

    it("reports an update when a newer selfhosted-* tag exists", async () => {
        mockReleases([
            { tag_name: "selfhosted-1.2.4", draft: false, prerelease: false },
        ]);

        const { GET } = await import("./route");
        const payload = await (await GET()).json();

        expect(payload).toEqual({
            current: "1.2.3",
            latest: "1.2.4",
            hasUpdate: true,
        });
    });

    it("picks the highest selfhosted-* tag by semver, not by list order", async () => {
        // GitHub's release list is sorted by created_at, not semver, so a
        // 0.12.10 patch can land before 0.12.9 in the response. The route
        // must sort by semver before picking.
        mockReleases([
            { tag_name: "selfhosted-1.3.5", draft: false, prerelease: false },
            { tag_name: "selfhosted-1.3.10", draft: false, prerelease: false },
        ]);

        const { GET } = await import("./route");
        const payload = await (await GET()).json();

        expect(payload.latest).toBe("1.3.10");
        expect(payload.hasUpdate).toBe(true);
    });

    it("ignores draft and prerelease tags", async () => {
        mockReleases([
            { tag_name: "selfhosted-2.0.0", draft: true, prerelease: false },
            { tag_name: "selfhosted-1.5.0", draft: false, prerelease: true },
            { tag_name: "selfhosted-1.2.4", draft: false, prerelease: false },
        ]);

        const { GET } = await import("./route");
        const payload = await (await GET()).json();

        expect(payload.latest).toBe("1.2.4");
    });

    it("ignores tags that don't match the selfhosted-* pattern", async () => {
        // Cloud releases use plain `vX.Y.Z` and shouldn't influence the
        // self-hosted update banner.
        mockReleases([
            { tag_name: "v9.9.9", draft: false, prerelease: false },
            { tag_name: "selfhosted-1.2.4", draft: false, prerelease: false },
        ]);

        const { GET } = await import("./route");
        const payload = await (await GET()).json();

        expect(payload.latest).toBe("1.2.4");
    });

    it("returns null latest when no selfhosted release matches", async () => {
        mockReleases([
            { tag_name: "v9.9.9", draft: false, prerelease: false },
        ]);

        const { GET } = await import("./route");
        const payload = await (await GET()).json();

        expect(payload).toEqual({
            current: "1.2.3",
            latest: null,
            hasUpdate: false,
        });
    });

    it("returns hasUpdate=false when current already matches latest", async () => {
        mockReleases([
            { tag_name: "selfhosted-1.2.3", draft: false, prerelease: false },
        ]);

        const { GET } = await import("./route");
        const payload = await (await GET()).json();

        expect(payload).toEqual({
            current: "1.2.3",
            latest: "1.2.3",
            hasUpdate: false,
        });
    });

    it("returns null latest when RELEASE_VERSION is not a parseable semver (e.g. 'local')", async () => {
        process.env.RELEASE_VERSION = "local";
        const fetchSpy = jest.fn();
        global.fetch = fetchSpy as any;

        const { GET } = await import("./route");
        const payload = await (await GET()).json();

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(payload).toEqual({
            current: "local",
            latest: null,
            hasUpdate: false,
        });
    });

    it("falls back gracefully when GitHub responds with an error status", async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 503,
            json: jest.fn(),
        } as any);

        const { GET } = await import("./route");
        const payload = await (await GET()).json();

        expect(payload).toEqual({
            current: "1.2.3",
            latest: null,
            hasUpdate: false,
        });
    });

    it("falls back gracefully when fetch throws", async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error("network down"));

        const { GET } = await import("./route");
        const payload = await (await GET()).json();

        expect(payload).toEqual({
            current: "1.2.3",
            latest: null,
            hasUpdate: false,
        });
    });

    it("skips the GitHub fetch when WEB_NODE_ENV is not self-hosted (cloud)", async () => {
        process.env.WEB_NODE_ENV = "production";
        const fetchSpy = jest.fn();
        global.fetch = fetchSpy as any;

        const { GET } = await import("./route");
        const payload = await (await GET()).json();

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(payload).toEqual({
            current: "1.2.3",
            latest: null,
            hasUpdate: false,
        });
    });
});
