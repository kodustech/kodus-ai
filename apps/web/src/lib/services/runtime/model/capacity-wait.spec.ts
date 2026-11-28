import { capacityWaitSentence } from "./capacity-wait";

describe("capacityWaitSentence", () => {
    const at = "2026-11-17T12:00:00.000Z";
    it("names how many hosts are busy and when the first frees at the latest", () => {
        expect(
            capacityWaitSentence({ signature: "no_capacity", at, hosts: 2, nextFreeAt: "2026-11-17T12:03:20.000Z" }),
        ).toBe("All 2 hosts that can run this environment are busy; the first frees in 4 min at the latest.");
        expect(capacityWaitSentence({ signature: "no_capacity", at, hosts: 1 })).toBe(
            "The one host that can run this environment is busy.",
        );
    });
    it("names the memory a host lacks and the Runs ahead", () => {
        expect(
            capacityWaitSentence({ signature: "no_capacity", at, needMb: 14_336, freeMb: 409, ahead: 2 }),
        ).toBe("The host has 0.4 GB of memory free and this machine needs 14 GB; 2 Runs are ahead in line.");
    });
    it("names the organization's cap of shared machines", () => {
        expect(
            capacityWaitSentence({ signature: "org_capacity", at, cap: 8, nextFreeAt: "2026-11-17T12:10:00.000Z" }),
        ).toBe("Your organization is using all 8 machines it may hold on shared Kodus hosts; the first frees in 10 min at the latest.");
    });
    it("says only that the hosts are busy when an older Run carries no numbers, and nothing without a wait", () => {
        expect(capacityWaitSentence({ signature: "no_capacity", at })).toBe(
            "Every host that can run this environment is busy.",
        );
        expect(capacityWaitSentence(undefined)).toBeUndefined();
        expect(capacityWaitSentence(null)).toBeUndefined();
    });
});
