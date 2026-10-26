/** Temporary, fixed-category diagnosis of the three provider QA executions. */
import { execFileSync } from 'node:child_process';

const sql = `with targets(pr) as (values (1232), (1177), (2219)), latest as (
    select distinct on ("pullRequestNumber") "pullRequestNumber" as pr,
        case when status::text in ('success','error','partial_error','skipped','in_progress','pending')
            then status::text else 'other' end as status,
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
            else 'other' end as detail
    from automation_execution
    where "pullRequestNumber" in (1232,1177,2219)
      and "createdAt" >= '2026-10-26 16:50:00+00'
    order by "pullRequestNumber", "createdAt" desc
)
select distinct 'status=' || coalesce(latest.status,'missing') ||
    ',cause=' || coalesce(latest.cause,'none') ||
    ',detail=' || coalesce(latest.detail,'none')
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
        /^status=(success|error|partial_error|skipped|in_progress|pending|other|missing),cause=(billing|auth|sandbox|model|network|provider|none|other),detail=(llm|billing|sandbox|git_provider|http_401|http_403|token|auth_other|no_change|pr_state|config|none|other)$/;
    if (
        lines.length < 1 ||
        lines.length > 3 ||
        lines.some((line) => !allowed.test(line))
    ) {
        throw new Error('unexpected diagnostic output');
    }
    for (const line of lines) console.log(`approval-qa: ${line}`);
} catch {
    console.log('approval-qa: unavailable');
    process.exitCode = 1;
}
