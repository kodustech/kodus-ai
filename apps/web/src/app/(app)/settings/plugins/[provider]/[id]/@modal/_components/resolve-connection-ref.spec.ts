import { resolveConnectionRef } from "./resolve-connection-ref";

describe("resolveConnectionRef (plugin disconnect identifier)", () => {
    const INTEGRATION_ID = "atlassian-rovo-default";
    const CONNECTION_PK = "d8de7d3e-9dbf-4f73-8471-62cde9d9f1a5";

    it("uses the connection PK when present", () => {
        expect(
            resolveConnectionRef({
                id: INTEGRATION_ID,
                connectionId: CONNECTION_PK,
            }),
        ).toBe(CONNECTION_PK);
    });

    // The prod "Connection ID not found" case: the connections list failed to
    // load server-side, so the plugin carries no `connectionId`. The old code
    // read only `plugin.connectionId` (undefined) and hard-threw, leaving the
    // user unable to disconnect a plugin shown as connected.
    it("falls back to the integrationId when connectionId is absent", () => {
        const plugin = { id: INTEGRATION_ID, connectionId: undefined };

        // Baseline of the bug: the PK alone is undefined → the old hard throw.
        expect(plugin.connectionId).toBeUndefined();

        // Fix: resolve to the integrationId so disconnect still works.
        expect(resolveConnectionRef(plugin)).toBe(INTEGRATION_ID);
    });

    it("is undefined only when nothing identifies the plugin", () => {
        expect(resolveConnectionRef({})).toBeUndefined();
    });
});
