import { hostsProblem, nameProblem, parseHostsInput, valueProblem } from "./secrets";

describe("Runtime secret form rules", () => {
    it("reads hosts one per line or separated by commas, lower case, without repeats", () => {
        expect(parseHostsInput(" NPM.corp.example.\nghcr.io, npm.corp.example  ")).toEqual(["npm.corp.example", "ghcr.io"]);
    });

    it.each([
        ["*.corp.example", "wildcard"],
        ["10.0.0.5", "IP address"],
        ["localhost", "not a host name"],
    ])("refuses %s as a host", (host, why) => {
        expect(hostsProblem([host])).toContain(why);
    });

    it("refuses a name that is not an environment variable", () => {
        expect(nameProblem("npm-token")).toBeDefined();
        expect(nameProblem("NPM_TOKEN")).toBeUndefined();
    });

    it("refuses a value with a line break without repeating it", () => {
        const problem = valueProblem("npm_synthetic\r\nX-Injected: 1");
        expect(problem).toBeDefined();
        expect(problem).not.toContain("npm_synthetic");
    });
});
