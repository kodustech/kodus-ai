import type { RunCapacityWait } from "../contracts";

// Why a Run waits for a host, in one sentence from the numbers the hub
// gave (the projection's capacityWait). `nextFreeAt` is an upper bound (the
// earliest hard expiry of a machine on the full hosts), so it reads "at the
// latest", counted from the last refusal (`at`): the page needs no clock.

const gb = (mb: number) => {
    const g = mb / 1024;
    return `${g >= 10 ? Math.round(g) : Math.round(g * 10) / 10} GB`;
};

const plural = (n: number, one: string, many = `${one}s`) =>
    `${n} ${n === 1 ? one : many}`;

/** "; the first frees in 4 min at the latest", or nothing when the time is not known. */
const freesIn = (w: Pick<RunCapacityWait, "at" | "nextFreeAt">): string => {
    const next = Date.parse(w.nextFreeAt ?? "");
    const at = Date.parse(w.at ?? "");
    if (Number.isNaN(next) || Number.isNaN(at)) return "";
    const minutes = Math.max(1, Math.ceil((next - at) / 60_000));
    return `; the first frees in ${minutes} min at the latest`;
};

const isCount = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n) && n >= 0;

/** One sentence of why the Run waits for a host; undefined when it does not wait. */
export const capacityWaitSentence = (
    w: RunCapacityWait | null | undefined,
): string | undefined => {
    if (!w || typeof w !== "object") return undefined;
    if (w.signature === "org_capacity")
        return `Your organization is using all ${isCount(w.cap) ? `${w.cap} ` : ""}machines it may hold on shared Kodus hosts${freesIn(w)}.`;
    if (isCount(w.needMb) && isCount(w.freeMb)) {
        const ahead = isCount(w.ahead) && w.ahead > 0 ? `; ${plural(w.ahead, "Run")} ${w.ahead === 1 ? "is" : "are"} ahead in line` : "";
        return `The host has ${gb(w.freeMb)} of memory free and this machine needs ${gb(w.needMb)}${ahead}.`;
    }
    if (isCount(w.hosts) && w.hosts > 1)
        return `All ${w.hosts} hosts that can run this environment are busy${freesIn(w)}.`;
    if (w.hosts === 1)
        return `The one host that can run this environment is busy${freesIn(w)}.`;
    return `Every host that can run this environment is busy${freesIn(w)}.`;
};
