import { readReproductionDownload } from "./reproduction";
import { reproductionManifest, ReproductionManifestSchema } from "@libs/runtime/run/reproduction";

const expected = { runId: "run-1", probeId: "probe-1" };
const data = () => ({
    filename: "kody-repro-pr7-probe-1.json",
    manifest: {
        schemaVersion: 1,
        kind: "kodus.runtime.reproduction",
        run: { runId: "run-1", repositoryName: "acme/shop", prNumber: 7, baseSha: "a".repeat(40), headSha: "b".repeat(40) },
        probe: { probeId: "probe-1", entryPoint: "POST /orders", purpose: "empty cart", expected: "400", spec: { kind: "http", target: { service: "web", port: 3000 }, method: "POST", path: "/orders", timeoutMs: 1000 } },
    },
});

describe("reproduction data boundary", () => {
    it("accepts versioned data without introducing a browser dependency on server modules", () => {
        const value = data();
        expect(readReproductionDownload(value, expected)).toBe(value);
    });

    it.each([
        { filename: "legacy.sh", script: "echo unsafe" },
        { ...data(), script: "echo unsafe" },
        { ...data(), filename: "../../unsafe.json" },
        { ...data(), manifest: { ...data().manifest, schemaVersion: 2 } },
        { ...data(), manifest: { ...data().manifest, boot: { migrate: "unsafe" } } },
        { ...data(), manifest: { ...data().manifest, probe: { ...data().manifest.probe, spec: { kind: "shell", command: "unsafe" } } } },
        { ...data(), manifest: { ...data().manifest, probe: { ...data().manifest.probe, spec: { ...data().manifest.probe.spec, command: "unsafe" } } } },
        { ...data(), manifest: { ...data().manifest, run: { ...data().manifest.run, imageId: "latest" } } },
    ])("rejects legacy/unknown executable shapes: %j", (value) => {
        expect(readReproductionDownload(value, expected)).toBeUndefined();
    });

    it("refuses another Run or probe in cached data", () => {
        expect(readReproductionDownload(data(), { ...expected, runId: "other" })).toBeUndefined();
        expect(readReproductionDownload(data(), { ...expected, probeId: "other" })).toBeUndefined();
    });

    it("accepts the server's data when a padded legacy alias has no concrete pin", () => {
        const recorded = ReproductionManifestSchema.parse(data().manifest);
        const response = reproductionManifest({ ...recorded.run, imageId: " latest ", reproduction: { probes: [recorded.probe] }, probeId: expected.probeId })!;
        expect(response.manifest.run).not.toHaveProperty("imageId");
        expect(readReproductionDownload(response, expected)).toBe(response);
    });
});
