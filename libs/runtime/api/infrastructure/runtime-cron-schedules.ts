// The schedules of the Runtime's product crons, from one loader. @Cron takes
// its expression when the class is declared, before any provider exists, so
// this module reads the environment once, at import.

export interface RuntimeCronSchedules {
    /** RUNTIME_CRON_WEBHOOK_RECONCILER: a tick lists one page of open PRs per automatic repository. */
    webhookReconciler: string;
    productRetention: string;
    prSessionSweep: string;
    poolScheduler: string;
    publicationRedrive: string;
}

export function loadRuntimeCronSchedules(env: NodeJS.ProcessEnv): RuntimeCronSchedules {
    return {
        webhookReconciler: env.RUNTIME_CRON_WEBHOOK_RECONCILER || '*/10 * * * *',
        productRetention: env.RUNTIME_CRON_PRODUCT_RETENTION || '*/10 * * * *',
        prSessionSweep: env.RUNTIME_CRON_PR_SESSION_SWEEP || '*/30 * * * *',
        poolScheduler: env.RUNTIME_CRON_POOL_SCHEDULER || '*/5 * * * *',
        publicationRedrive: env.RUNTIME_CRON_PUBLICATION_REDRIVE || '* * * * *',
    };
}

export const RUNTIME_CRON_SCHEDULES: RuntimeCronSchedules = loadRuntimeCronSchedules(process.env);
