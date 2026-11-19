/**
 * Which build and which ECS task a process is: stamped on every log line
 * and every BetterStack alert, so a death, a reclaimed message or an
 * orphaned job can be traced to the release and the task it came from
 * without guessing from deploy times.
 *
 * The version is baked into the image (`RELEASE_VERSION` build arg). The
 * task id is only known once the ECS metadata endpoint answers, after
 * startup, so it is set later by the app's bootstrap.
 */
export interface RuntimeIdentity {
    version?: string;
    taskId?: string;
}

let taskId: string | undefined;

export function setRuntimeTaskId(id: string | undefined): void {
    taskId = id || undefined;
}

export function runtimeIdentity(): RuntimeIdentity {
    const version = process.env.RELEASE_VERSION?.trim() || undefined;
    return {
        ...(version ? { version } : {}),
        ...(taskId ? { taskId } : {}),
    };
}
