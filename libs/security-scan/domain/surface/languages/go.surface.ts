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
    SQL_SHAPE,
    timingCompare,
} from './shared';

const REQ = String.raw`\b(?:r\.URL|r\.Form|r\.FormValue|r\.PostFormValue|c\.Param|c\.Query|c\.PostForm|c\.FormValue|c\.Params|ctx\.Param|ctx\.Query|chi\.URLParam|mux\.Vars)\b`;
/** Non-literal URL argument: lowercase variable, Sprintf, or a concatenation. */
const VAR_URL = String.raw`(?:[a-z_][\w.\[\]()]*\s*[,)+]|fmt\.Sprintf\(|"[^"]*"\s*\+)`;

export const GO_SURFACE: LanguageSurface = {
    language: 'go',
    glob: '*.go',
    patterns: [
        entry(
            'go.nethttp.route',
            String.raw`\.(?:HandleFunc|Handle)\(\s*"`,
            'net/http',
        ),
        entry(
            'go.router.route',
            String.raw`\b\w+\.(?:GET|POST|PUT|PATCH|DELETE|Any|Get|Post|Put|Patch|Delete|Options|Head|Group|Route|Mount|All)\(\s*"/`,
            'gin/echo/chi/fiber',
        ),
        entry(
            'go.handler.signature',
            String.raw`\w+\s+(?:\*gin\.Context|echo\.Context|\*fiber\.Ctx)\b|\w+\s+http\.ResponseWriter\s*,\s*\w+\s+\*http\.Request\b`,
        ),
        entry(
            'go.grpc.server',
            String.raw`\bRegister\w+Server\(|\bUnimplemented\w+Server\b`,
            'grpc',
        ),
        entry(
            'go.queue.consumer',
            String.raw`\.(?:Consume|QueueSubscribe|ReadMessage|FetchMessage|ConsumePartition)\(|\bnats\.\w*Subscribe\w*\(|\bnc\.Subscribe\(`,
            'amqp/kafka/nats',
        ),
        entry(
            'go.cli.argv',
            String.raw`\bos\.Args\b|\bflag\.(?:String|Int|Bool|Parse|StringVar|IntVar|BoolVar|Arg|Args)\b|\bcobra\.Command\b`,
            'cli',
        ),

        auth(
            'go.auth.middleware',
            String.raw`\b(?:AuthMiddleware|RequireAuth|Authenticate|Authorize|JWTAuth|RequireRole|CheckPermission|jwtauth\.Verifier|jwtauth\.Authenticator|echojwt\.WithConfig|middleware\.JWT\w*|middleware\.BasicAuth|gin\.BasicAuth|keyauth\.New|jwtware\.New)\b|\.Use\(\s*\w*(?:[Aa]uth|JWT|[Jj]wt)\w*`,
        ),

        sink(
            'go.sql.string-built',
            'injection',
            'CWE-89',
            any(
                sqlConcat(),
                String.raw`fmt\.Sprintf\(\s*"[^"]*${SQL_SHAPE}[^"]*%[sv]`,
                String.raw`fmt\.Sprintf\(\s*\x60[^\x60]*${SQL_SHAPE}[^\x60]*%[sv]`,
            ),
        ),
        sink(
            'go.sql.raw-call',
            'injection',
            'CWE-89',
            String.raw`\.(?:Query|QueryRow|Exec|QueryContext|ExecContext|QueryRowContext|Raw|Where|Order|Select)\(\s*(?:ctx\s*,\s*)?(?:fmt\.Sprintf\(|"[^"]*"\s*\+|[a-z]\w*\s*\+)`,
        ),
        sink(
            'go.exec.command',
            'injection',
            'CWE-78',
            // A shell, or a program name that is not a literal; exec.Command
            // with a literal binary and separate args never reaches a shell.
            String.raw`\bexec\.Command(?:Context)?\(\s*(?:ctx\s*,\s*)?(?:"(?:sh|bash|/bin/sh|/bin/bash|cmd|cmd\.exe|powershell)"|[a-z]\w*\s*[,)])|\bsyscall\.Exec\(`,
        ),
        sink(
            'go.template.injection',
            'injection',
            'CWE-1336',
            String.raw`\btemplate\.New\([^)]*\)\.Parse\(\s*(?:[a-z]\w*\s*\)|fmt\.Sprintf\(|"[^"]*"\s*\+)`,
        ),
        sink(
            'go.path.traversal',
            'injection',
            'CWE-22',
            String.raw`\b(?:os\.(?:Open|OpenFile|ReadFile|Create|Remove|RemoveAll|WriteFile)|ioutil\.ReadFile|http\.ServeFile|filepath\.Join|path\.Join)\([^)]*${REQ}|\bc\.(?:File|Attachment)\(\s*[a-z]\w*`,
        ),
        sink(
            'go.http.variable-url',
            'ssrf',
            'CWE-918',
            String.raw`\bhttp\.(?:Get|Head|Post|PostForm)\(\s*${VAR_URL}|\bhttp\.NewRequest(?:WithContext)?\((?:\s*\w+\s*,)?\s*(?:"\w*"|http\.Method\w+|\w+)\s*,\s*${VAR_URL}|\b(?:client|httpClient|http\.DefaultClient)\.(?:Get|Head|Post)\(\s*${VAR_URL}|\.R\(\)\.(?:Get|Post|Put|Delete)\(\s*${VAR_URL}`,
        ),
        sink(
            'go.orm.by-id-only',
            'authz',
            'CWE-639',
            String.raw`\.(?:First|Find|Take|Delete)\(\s*&?\w+\s*,\s*(?:id|\w+ID|\w+Id|c\.Param\("\w*id"\))\s*\)|\.Where\(\s*"id\s*=\s*\?"\s*,\s*[\w.()"]+\)\s*\.(?:First|Find|Take|Delete)\(|\.(?:FindByID|GetByID|FindById|GetById)\(\s*(?:ctx\s*,\s*)?(?:c\.Param|chi\.URLParam|mux\.Vars|c\.Params|ctx\.Param)\(`,
            'gorm',
        ),
        sink(
            'go.log.sensitive',
            'data_exposure',
            'CWE-532',
            logsSensitive(
                String.raw`\b(?:log|logger|slog|logrus|zap|sugar|l)\.(?:Print\w*|Info\w*|Debug\w*|Warn\w*|Error\w*|Fatal\w*)\(|\bfmt\.(?:Print|Printf|Println)\(`,
            ),
        ),
        sink(
            'go.response.error-detail',
            'data_exposure',
            'CWE-209',
            String.raw`\bhttp\.Error\(\s*\w+\s*,\s*err\.Error\(\)|\bc\.(?:JSON|String|AbortWithStatusJSON|IndentedJSON)\([^)]*\berr\.Error\(\)|\bdebug\.Stack\(\)`,
        ),
        sink(
            'go.response.whole-entity',
            'data_exposure',
            'CWE-200',
            String.raw`\bjson\.NewEncoder\(\s*\w+\s*\)\.Encode\(\s*&?(?:user|users|account|u)\s*\)|\bc\.JSON\(\s*[\w.]+\s*,\s*&?(?:user|users|account)\s*\)`,
        ),
        sink(
            'go.crypto.weak-hash',
            'secret_identity',
            'CWE-328',
            String.raw`\b(?:md5|sha1)\.(?:New|Sum)\(`,
        ),
        sink(
            'go.crypto.weak-cipher',
            'secret_identity',
            'CWE-327',
            String.raw`\b(?:des\.NewCipher|des\.NewTripleDESCipher|rc4\.NewCipher)\(`,
        ),
        sink(
            'go.crypto.insecure-random',
            'secret_identity',
            'CWE-338',
            // These functions exist only in math/rand; crypto/rand has Read/Int.
            any(
                randomForSecret(
                    String.raw`\brand\.(?:Intn|Int63n?|Int31n?|Uint32|Uint64|Float64|Perm)\(`,
                ),
                String.raw`\w*(?:[Ll]etter|[Cc]har|[Aa]lphabet|[Rr]unes)\w*\[rand\.(?:Intn|Int63)\(`,
            ),
        ),
        timingCompare(
            'go',
            String.raw`\bbytes\.Equal\([^)]*(?:[Ss]ig|[Mm]ac|[Hh]mac|[Tt]oken|[Dd]igest|[Ss]ecret)`,
        ),
        sink(
            'go.jwt.unverified',
            'secret_identity',
            'CWE-347',
            String.raw`\bParseUnverified\(|\bUnsafeAllowNoneSignatureType\b|\bSigningMethodNone\b`,
        ),
        sink(
            'go.tls.verification-disabled',
            'secret_identity',
            'CWE-295',
            String.raw`\bInsecureSkipVerify\s*:\s*true`,
        ),
        ...commonSinks('go', { nosql: true }),
    ],
};
