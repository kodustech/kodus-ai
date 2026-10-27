/** Temporary, fixed-category diagnosis of the latest GitLab provider QA execution. */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';

const sql = `with targets(pr) as (values (1242)), latest as (
    select distinct on (ae."pullRequestNumber") ae."pullRequestNumber" as pr,
        case when ta."teamUuid" = 'ee481c63-f6fc-4631-b74a-65735e882c13'
            then 'current' else 'other' end as route,
        case when ae.status::text in ('success','error','partial_error','skipped','in_progress','pending')
            then ae.status::text else 'other' end as status,
        case
            when "errorMessage" ~* 'credit|billing|licen[sc]|subscription|trial' then 'billing'
            when "errorMessage" ~* 'permission|unauthor|forbidden|token' then 'auth'
            when "errorMessage" ~* 'sandbox|e2b|container' then 'sandbox'
            when "errorMessage" ~* 'model|llm|openai|anthropic|gemini|agent' then 'model'
            when "errorMessage" ~* 'timeout|timed out|network|fetch' then 'network'
            when "errorMessage" ~* 'repository|provider|gitlab|bitbucket|azure' then 'provider'
            when "errorMessage" is null then 'none'
            else 'other' end as cause,
        case
            when "errorMessage" ~* '429|rate.limit|too.many.requests' then 'rate_limit'
            when "errorMessage" ~* 'timed.out|timeout' then 'timeout'
            when "errorMessage" ~* 'fetch|network|connect' then 'network'
            when "errorMessage" ~* 'openai|anthropic|gemini|llm|model|api.key' then 'llm'
            when "errorMessage" ~* 'billing|license|credit|subscription|trial' then 'billing'
            when "errorMessage" ~* 'e2b|sandbox|container' then 'sandbox'
            when "errorMessage" ~* 'bitbucket|azure|gitlab|repository|provider' then 'git_provider'
            when "errorMessage" ~* '401' then 'http_401'
            when "errorMessage" ~* '403' then 'http_403'
            when "errorMessage" ~* 'token' then 'token'
            when "errorMessage" ~* 'permission|forbidden|unauthor|authenticat' then 'auth_other'
            when "errorMessage" ~* 'already|new.commit|no.change' then 'no_change'
            when "errorMessage" ~* 'closed|merged|pr.state|pull.request.state' then 'pr_state'
            when "errorMessage" ~* 'disabled|paused|manual|branch' then 'config'
            when "errorMessage" is null then 'none'
            else 'other' end as detail,
        case
            when "errorMessage" ~* 'fireworks|deepseek' then 'fireworks'
            when "errorMessage" ~* 'openai' then 'openai'
            when "errorMessage" ~* 'anthropic|claude' then 'anthropic'
            when "errorMessage" ~* 'google|gemini|vertex' then 'google'
            else 'unknown' end as upstream,
        case
            when "errorMessage" ~* '401' then 'http_401'
            when "errorMessage" ~* '403' then 'http_403'
            when "errorMessage" ~* 'missing|not.configured|no.api.key' then 'missing'
            when "errorMessage" ~* 'invalid|incorrect|expired|revoked' then 'invalid'
            else 'unknown' end as auth_kind
    from automation_execution ae
    left join team_automations ta on ta.uuid = ae.team_automation_id
    where ae."pullRequestNumber" = 1242
      and ae."createdAt" >= '2026-10-27 10:37:00+00'
      and ae."createdAt" < '2026-10-27 10:51:08+00'
    order by ae."pullRequestNumber", ae."createdAt" desc
)
select distinct 'route=' || coalesce(latest.route,'missing') ||
    ',status=' || coalesce(latest.status,'missing') ||
    ',cause=' || coalesce(latest.cause,'none') ||
    ',detail=' || coalesce(latest.detail,'none') ||
    ',upstream=' || coalesce(latest.upstream,'unknown') ||
    ',auth_kind=' || coalesce(latest.auth_kind,'unknown')
from targets left join latest using (pr) order by 1`;

try {
    const output = execFileSync(
        'docker',
        [
            'exec',
            '-i',
            'db_postgres',
            'sh',
            '-c',
            'PGPASSWORD=$POSTGRES_PASSWORD psql -tA -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
        ],
        { encoding: 'utf8', input: sql, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    const lines = output.split('\n');
    const allowed =
        /^route=(current|other|missing),status=(success|error|partial_error|skipped|in_progress|pending|other|missing),cause=(billing|auth|sandbox|model|network|provider|none|other),detail=(rate_limit|timeout|network|llm|billing|sandbox|git_provider|http_401|http_403|token|auth_other|no_change|pr_state|config|none|other),upstream=(fireworks|openai|anthropic|google|unknown),auth_kind=(http_401|http_403|missing|invalid|unknown)$/;
    if (
        lines.length < 1 ||
        lines.length > 1 ||
        lines.some((line) => !allowed.test(line))
    ) {
        throw new Error('unexpected diagnostic output');
    }
    for (const line of lines) console.log(`approval-qa: ${line}`);
} catch {
    console.log('approval-qa: unavailable');
    process.exitCode = 1;
}

// A one-token completion checks the exact managed model used by trial reviews.
// The key and upstream response body stay in the VM; only the HTTP class leaves.
async function probeManagedModel(): Promise<void> {
    const key =
        process.env.API_FIREWORKS_API_KEY || process.env.FIREWORKS_API_KEY;
    if (!key || key === 'preview-disabled') {
        console.log('approval-qa: managed-model=not_configured');
        return;
    }
    try {
        const response = await fetch(
            `${process.env.API_FIREWORKS_BASE_URL || 'https://api.fireworks.ai/inference/v1'}/chat/completions`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'accounts/fireworks/models/deepseek-v4p1-flash',
                    messages: [{ role: 'user', content: 'ping' }],
                    max_tokens: 1,
                }),
                signal: AbortSignal.timeout(15_000),
            },
        );
        const category = response.ok
            ? 'ok'
            : response.status === 401 || response.status === 403
              ? 'auth_rejected'
              : response.status === 404
                ? 'model_unavailable'
                : response.status === 429
                  ? 'rate_limited'
                  : 'other_http';
        console.log(`approval-qa: managed-model=${category}`);
        if (category !== 'ok') process.exitCode = 1;
    } catch {
        console.log('approval-qa: managed-model=network_error');
        process.exitCode = 1;
    }
}

void probeManagedModel();
