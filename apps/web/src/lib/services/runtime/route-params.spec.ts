import { decodeRouteParam } from "./route-params";

describe("decodeRouteParam", () => {
    it("decodes an encoded id and keeps a malformed one as it came", () => {
        expect(decodeRouteParam("run%3A1")).toBe("run:1");
        expect(decodeRouteParam("plain-id")).toBe("plain-id");
        expect(decodeRouteParam("%E0%A4%A")).toBe("%E0%A4%A");
    });
});
