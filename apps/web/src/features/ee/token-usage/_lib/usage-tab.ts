export type UsageTab = "llm" | "runtime";

/** The tab a `?tab=` value opens; anything but `runtime` is the LLM tokens tab. */
export const usageTabFor = (value: string | string[] | undefined): UsageTab =>
    value === "runtime" ? "runtime" : "llm";
