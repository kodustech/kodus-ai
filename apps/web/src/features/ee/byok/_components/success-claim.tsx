/**
 * What a passing test is entitled to claim.
 *
 * Two checks reach this banner and they do not prove the same thing. A
 * `catalog` pass fetched the provider's model list with the org's own key: it
 * proves the key authenticates and the id is listed, and it never called the
 * model. Saying "Connection OK" for that is a promise the check did not make —
 * a customer read exactly this banner as proof the model worked while every
 * real call to it was being refused for want of a route, and went off to
 * replace a key that was fine.
 */
export function SuccessClaim({
    latencyMs,
    verifiedBy,
}: {
    latencyMs: number;
    verifiedBy?: "catalog" | "probe";
}) {
    if (verifiedBy === "catalog") {
        return (
            <>
                Key works and your provider lists this model (
                <span className="tabular-nums">{latencyMs}ms</span>). This check
                doesn&apos;t call the model, so it can&apos;t confirm it will
                run.
            </>
        );
    }
    return (
        <>
            Connection OK — provider responded in{" "}
            <span className="tabular-nums">{latencyMs}ms</span>.
        </>
    );
}
