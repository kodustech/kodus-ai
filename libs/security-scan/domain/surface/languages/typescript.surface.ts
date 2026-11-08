import { LanguageSurface } from '../surface.types';
import {
    any,
    auth,
    commonSinks,
    entry,
    logsSensitive,
    randomForSecret,
    sink,
    sqlConcat,
    sqlInString,
    timingCompare,
} from './shared';

/** Request-controlled values in Express/Koa/Nest/Next handlers. */
const REQ = String.raw`\b(?:req|request|ctx\.request|ctx)\.(?:params|query|body)\b`;
/**
 * First call argument that is not a constant: a lowercase identifier (so
 * `fetch(API_URL)` stays out), an interpolated template, or a concatenation.
 */
const VAR_ARG = String.raw`(?:[a-z_$][\w.$\[\]'"]*\s*[,)+]|\x60[^\x60]*\$\{|['"][^'"]*['"]\s*\+|new\s+URL\()`;

export const TYPESCRIPT_SURFACE: LanguageSurface = {
    language: 'typescript',
    glob: '*.{ts,tsx,js,jsx,mjs,cjs}',
    patterns: [
        entry(
            'ts.nest.route',
            String.raw`@(?:Get|Post|Put|Patch|Delete|All|Options|Head)\(`,
            'nestjs',
        ),
        entry(
            'ts.nest.message',
            String.raw`@(?:MessagePattern|EventPattern|GrpcMethod|GrpcStreamMethod|RabbitSubscribe|RabbitRPC|SqsMessageHandler|SubscribeMessage|Process)\(`,
            'nestjs',
        ),
        entry(
            'ts.graphql.resolver',
            // `@Query()` without a return-type thunk is Nest's REST param decorator.
            String.raw`@(?:Query|Mutation|Subscription|ResolveField)\(\s*(?:\(\)|returns\b|['"]\w+['"]\s*,\s*\(\))|^\s*(?:Query|Mutation|Subscription)\s*:\s*\{`,
            'graphql',
        ),
        entry(
            'ts.http.route',
            String.raw`\b(?:app|server|fastify|hono|\w*[Rr]outer|routes)\.(?:get|post|put|patch|delete|all|options|head|route|use)\(\s*['"\x60]/|\b(?:fastify|server|app)\.route\(\s*\{`,
            'express/koa/fastify/hono',
        ),
        entry(
            'ts.next.route-handler',
            String.raw`^\s*export\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|^\s*export\s+const\s+(?:GET|POST|PUT|PATCH|DELETE)\s*=`,
            'nextjs',
        ),
        entry(
            'ts.next.pages-api',
            String.raw`export\s+default\s+(?:async\s+)?function\s*\w*\s*\(\s*req\b|\(\s*req\s*:\s*NextApiRequest\b`,
            'nextjs',
        ),
        entry(
            'ts.next.server-action',
            String.raw`^\s*['"]use server['"]`,
            'nextjs',
        ),
        entry(
            'ts.trpc.procedure',
            String.raw`:\s*(?:t\.)?\w*[Pp]rocedure\b|\bt\.procedure\.`,
            'trpc',
        ),
        entry(
            'ts.lambda.handler',
            String.raw`^\s*export\s+(?:const|async\s+function|function)\s+handler\b|\bexports\.handler\s*=`,
            'aws-lambda',
        ),
        entry(
            'ts.queue.consumer',
            String.raw`\b(?:channel|ch|consumer|subscriber)\.(?:consume|subscribe|run)\(|\bnew\s+Worker\(\s*['"\x60]|\.on\(\s*['"]message['"]`,
            'amqp/kafka/bullmq/ws',
        ),
        entry(
            'ts.cli.argv',
            String.raw`\bprocess\.argv\b|\byargs\b|\bprogram\s*\.\s*(?:command|argument|option)\(`,
            'cli',
        ),

        auth(
            'ts.nest.guard',
            String.raw`@UseGuards\(|@(?:Roles|CheckPolicies|Permissions|RequirePermissions|Authorized|Auth|Public)\(|\bimplements\s+CanActivate\b`,
            'nestjs',
        ),
        auth(
            'ts.auth.middleware',
            String.raw`\b(?:passport\.authenticate|requireAuth|isAuthenticated|ensureAuthenticated|ensureLoggedIn|verifyToken|checkJwt|expressjwt|expressJwt|jwt\.verify|jwtVerify|withAuth|requireUser|getServerSession|clerkMiddleware|authMiddleware|protectedProcedure)\b|\bauth\(\)`,
        ),

        sink(
            'ts.sql.string-built',
            'injection',
            'CWE-89',
            // Tagged templates (sql`…`, $queryRaw`…`) are parameterized, so the
            // template must follow `(`, `=`, `,`, `:` or `return`, never an identifier.
            any(
                sqlConcat(),
                String.raw`(?:^|[(=,:+?]|return)\s*${sqlInString('\\x60', String.raw`\$\{`)}`,
            ),
        ),
        sink(
            'ts.sql.raw-call',
            'injection',
            'CWE-89',
            String.raw`\$(?:queryRawUnsafe|executeRawUnsafe)\(|\.(?:query|execute|raw|whereRaw|orderByRaw|havingRaw|joinRaw)\(\s*(?:\x60[^\x60]*\$\{|"[^"]*"\s*\+|'[^']*'\s*\+|[a-z_$][\w.$]*\s*\+)|\bsequelize\.query\(\s*(?:\x60[^\x60]*\$\{|[a-z_$][\w.$]*\s*[,)])`,
        ),
        sink(
            'ts.exec.shell',
            'injection',
            'CWE-78',
            // `[^.\w]` before exec keeps RegExp#exec out; execFile/spawn with an
            // argv array never reach a shell.
            String.raw`(?:^|[^.\w])(?:exec|execSync)\(\s*(?:\x60[^\x60]*\$\{|['"][^'"]*['"]\s*\+|[a-z_$][\w.$\[\]]*\s*[,)+])|\b(?:child_process|childProcess|cp)\.(?:exec|execSync)\(|\bshell\.exec\(|\bspawn(?:Sync)?\([^)]*\bshell\s*:\s*true|\bexecaCommand(?:Sync)?\(`,
        ),
        sink(
            'ts.eval',
            'injection',
            'CWE-94',
            String.raw`(?:^|[^.\w])eval\(\s*[^'"\s)]|\bnew\s+Function\(|\bvm\.(?:runInNewContext|runInThisContext|runInContext|compileFunction)\(|\bnew\s+vm\.Script\(|\bset(?:Timeout|Interval)\(\s*['"\x60]`,
        ),
        sink(
            'ts.template.injection',
            'injection',
            'CWE-1336',
            String.raw`\b(?:Handlebars|handlebars|ejs|pug|nunjucks|Mustache|mustache|_|lodash|doT|dot|Hogan|hogan)\.(?:compile|render|renderString|template)\(\s*[^'"\x60\s)]`,
        ),
        sink(
            'ts.nosql.operator-injection',
            'injection',
            'CWE-943',
            // A body/query OBJECT reaching a Mongo filter lets `{"$ne": null}` through.
            String.raw`\.(?:find|findOne|findOneAndUpdate|findOneAndDelete|updateOne|updateMany|deleteOne|deleteMany|countDocuments|aggregate|where)\(\s*(?:\{[^}]*:\s*)?(?:req|request|ctx\.request)\.(?:body|query)\b`,
            'mongodb',
        ),
        sink(
            'ts.path.traversal',
            'injection',
            'CWE-22',
            String.raw`\b(?:fs|fsp|fsPromises|promises)\.(?:readFile|readFileSync|createReadStream|writeFile|writeFileSync|createWriteStream|unlink|unlinkSync|rm|rmSync|readdir|readdirSync|appendFile|open|access|stat)\([^)]*\b(?:req|request|ctx|params|query|body|input)\b|\bres\.(?:sendFile|download)\(\s*[^'"\x60\s)]|\bpath\.(?:join|resolve)\([^)]*${REQ}`,
        ),
        sink(
            'ts.http.variable-url',
            'ssrf',
            'CWE-918',
            String.raw`(?:^|[^.\w])(?:fetch|\$fetch|ofetch|got|ky|needle|axios)\(\s*${VAR_ARG}|\b(?:axios|got|ky|superagent|undici|http|https|request)\.(?:get|post|put|patch|delete|head|request)\(\s*${VAR_ARG}|\baxios\(\s*\{[^}]*\burl\s*:\s*${VAR_ARG}`,
        ),
        sink(
            'ts.orm.lookup-by-request-id',
            'authz',
            'CWE-639',
            String.raw`\.(?:findById|findByPk|findOne\w*|findUnique\w*|findFirst\w*|findByIdAnd\w+|get\w*ById|deleteById|delete|update|destroy|remove)\([^)]*${REQ}|\.(?:findById|findByPk|findUnique|findOne|getById)\(\s*(?:params|args|input|query|body|dto)\.\w*[Ii]d\b`,
        ),
        sink(
            'ts.orm.by-id-only',
            'authz',
            'CWE-639',
            // `where: { id }` with nothing else: no owner/tenant scoping on the lookup.
            String.raw`\.(?:findOne|findFirst|findUnique|findOneBy|findOneOrFail|findOneByOrFail|update|delete|deleteOne|updateOne|findOneAndUpdate|findOneAndDelete)\(\s*\{\s*(?:where\s*:\s*\{\s*)?(?:_id|id|uuid)\s*(?::\s*[\w.$\[\]'"()]+\s*)?\}`,
        ),
        sink(
            'ts.log.sensitive',
            'data_exposure',
            'CWE-532',
            logsSensitive(
                String.raw`\b(?:console|logger|log|this\.logger|this\.log)\.(?:log|info|debug|warn|error|trace|verbose)\(`,
            ),
        ),
        sink(
            'ts.response.error-detail',
            'data_exposure',
            'CWE-209',
            String.raw`\b(?:res|reply|response)\b.*\b(?:err|error|e|ex|exception)\.stack\b|\bres\.(?:status\(\s*\d+\s*\)\.)?(?:send|json)\(\s*(?:err|error|e)\s*\)`,
        ),
        sink(
            'ts.response.whole-entity',
            'data_exposure',
            'CWE-200',
            String.raw`\b(?:res\.(?:status\(\s*\d+\s*\)\.)?(?:json|send)|NextResponse\.json|Response\.json|reply\.send)\(\s*(?:user|users|account|accounts|customer|profile)\s*[,)]`,
        ),
        sink(
            'ts.crypto.weak-hash',
            'secret_identity',
            'CWE-328',
            String.raw`\bcreateHash\(\s*['"](?:md5|sha1|md4|MD5|SHA1)['"]|(?:^|[^.\w])(?:md5|sha1)\(`,
        ),
        sink(
            'ts.crypto.weak-cipher',
            'secret_identity',
            'CWE-327',
            String.raw`\bcreateCipher(?:iv)?\(\s*['"](?:des|rc4|rc2|bf|blowfish|aes-\d+-ecb)|\bcreateCipher\(`,
        ),
        sink(
            'ts.crypto.insecure-random',
            'secret_identity',
            'CWE-338',
            any(
                randomForSecret(String.raw`Math\.random\(\)`),
                String.raw`Math\.random\(\)\.toString\(\s*36`,
            ),
        ),
        timingCompare('ts'),
        sink(
            'ts.jwt.unverified',
            'secret_identity',
            'CWE-347',
            String.raw`\bjwt\.decode\(|\balgorithms\s*:\s*\[[^\]]*['"]none['"]|\bignoreExpiration\s*:\s*true`,
        ),
        sink(
            'ts.tls.verification-disabled',
            'secret_identity',
            'CWE-295',
            String.raw`\brejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0`,
        ),
        ...commonSinks('ts', { nosql: true }),
    ],
};
