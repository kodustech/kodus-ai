import { connectionDownloadScope } from '../connection-download-scope';

describe('connectionDownloadScope', () => {
    it('exports every repository with the workspace defaults for a call naming no connection', () => {
        expect(connectionDownloadScope(undefined, ['r1'], null)).toEqual({});
    });

    it("exports only the connection's repositories, with the workspace defaults while the config is the workspace's", () => {
        expect(
            connectionDownloadScope('gl-b', ['r9'], {
                connectionScoped: false,
            }),
        ).toEqual({ repositoryIds: ['r9'], includeWorkspaceDefaults: true });
    });

    it("leaves the workspace defaults out of a connection's own config", () => {
        expect(
            connectionDownloadScope('gl-b', ['r9'], { connectionScoped: true }),
        ).toEqual({ repositoryIds: ['r9'], includeWorkspaceDefaults: false });
    });
});
