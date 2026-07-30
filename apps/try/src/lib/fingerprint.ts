const STORAGE_KEY = "kodus-try-fingerprint";

function randomFingerprint(): string {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function getOrCreateFingerprint(): string {
    if (typeof window === "undefined") return "";
    try {
        const existing = window.localStorage.getItem(STORAGE_KEY);
        if (existing) return existing;
        const fresh = randomFingerprint();
        window.localStorage.setItem(STORAGE_KEY, fresh);
        return fresh;
    } catch {
        return randomFingerprint();
    }
}
