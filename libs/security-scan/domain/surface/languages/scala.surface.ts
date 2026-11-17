import { LanguageSurface } from '../surface.types';
import { jcaCrypto, JVM_EQUALS_COMPARE } from './jvm.shared';
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

/** `s"…$x"` / `f"…$x"`; doobie/slick `sql"…$x"` binds parameters and stays out. */
const S_INTERP = String.raw`\b[sf]"[^"]*\$\{?[a-zA-Z_]`;
const VAR_ARG = String.raw`(?:[a-z]\w*(?:\.\w+)*\s*[,)+]|${S_INTERP}|"[^"]*"\s*\+)`;

export const SCALA_SURFACE: LanguageSurface = {
    language: 'scala',
    glob: '*.{scala,sc}',
    extraGlobs: [
        {
            glob: '{routes,*.routes}',
            patterns: [
                entry(
                    'scala.play.routes-file',
                    String.raw`^\s*(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/`,
                    'play',
                ),
            ],
        },
    ],
    patterns: [
        entry(
            'scala.play.action',
            String.raw`\bdef\s+\w+[^=]*=\s*(?:\w+\.)*\w*Action\b`,
            'play',
        ),
        entry(
            'scala.akka.route',
            String.raw`\b(?:path|pathPrefix|pathEndOrSingleSlash)\b\s*[({]|^\s*(?:get|post|put|delete|patch)\s*\{`,
            'akka-http/pekko-http',
        ),
        entry(
            'scala.http4s.route',
            String.raw`\bcase\s+(?:\w+\s*@\s*)?(?:GET|POST|PUT|DELETE|PATCH)\s*->|\bHttpRoutes\.of\[|\bendpoint\.(?:get|post|put|delete|patch)\b`,
            'http4s/tapir',
        ),
        entry(
            'scala.cli.main',
            String.raw`\bdef\s+main\s*\(\s*args\s*:\s*Array\[String\]\s*\)|\bextends\s+App\b`,
            'cli',
        ),

        auth(
            'scala.auth',
            String.raw`\b(?:authenticate\w*|authorize\w*)\s*\(|\b\w*(?:Authenticated|Secured|Auth)\w*Action\b|\bSilhouette\b|\bAuthedRoutes\b|\bAuthMiddleware\b`,
        ),

        sink(
            'scala.sql.string-built',
            'injection',
            'CWE-89',
            any(
                sqlConcat(),
                String.raw`\b[sf]"[^"]*${SQL_SHAPE}[^"]*\$\{?[a-zA-Z_]`,
                // `#$x` splices raw text into slick/doobie SQL.
                String.raw`\bsql"[^"]*#\$\{?[a-zA-Z_]`,
            ),
        ),
        sink(
            'scala.sql.raw-call',
            'injection',
            'CWE-89',
            String.raw`\.(?:executeQuery|executeUpdate|execute)\(\s*(?:${S_INTERP}|[a-z]\w*\s*\))|\bSQL\(\s*${S_INTERP}`,
        ),
        sink(
            'scala.exec',
            'injection',
            'CWE-78',
            String.raw`\bProcess\(\s*(?:${S_INTERP}|[a-z]\w*\s*\)|"[^"]*"\s*\+)|\b[sf]"[^"]*"\s*\.\s*!!?|\b[a-z]\w*\s*\.\s*!!?|Runtime\.getRuntime\(\)\.exec\(`,
            'scala.sys.process',
        ),
        sink(
            'scala.eval',
            'injection',
            'CWE-94',
            String.raw`\b(?:toolbox|tb|ToolBox)\w*\.eval\(|\bIMain\b|\b\w*[Ee]ngine\.eval\(|\bnew\s+ObjectInputStream\(`,
        ),
        sink(
            'scala.path.traversal',
            'injection',
            'CWE-22',
            String.raw`\bnew\s+File\(\s*(?:${S_INTERP}|[^)]*\brequest\.)|\bPaths\.get\(\s*${S_INTERP}|\bsendFile\(\s*new\s+File\(\s*(?:${S_INTERP}|[a-z])`,
        ),
        sink(
            'scala.http.variable-url',
            'ssrf',
            'CWE-918',
            String.raw`\b(?:ws|wsClient)\.url\(\s*${VAR_ARG}|\bHttpRequest\([^)]*\buri\s*=\s*${VAR_ARG}|\buri"[^"]*\$\{?[a-zA-Z_]|\bUri\.unsafeFromString\(\s*${VAR_ARG}|\bSource\.fromURL\(\s*${VAR_ARG}|\bnew\s+URL\(\s*${VAR_ARG}`,
            'play-ws/akka-http/sttp/http4s',
        ),
        sink(
            'scala.orm.by-id-only',
            'authz',
            'CWE-639',
            String.raw`\.filter\(\s*_\.id\s*===\s*[\w.]+\s*\)|\b\w*(?:[Rr]epo|[Dd]ao)\w*\.(?:findById|getById|get|find)\(\s*\w*[Ii]d\s*\)`,
            'slick',
        ),
        sink(
            'scala.log.sensitive',
            'data_exposure',
            'CWE-532',
            logsSensitive(
                String.raw`\b(?:log|logger|Logger)\.(?:info|debug|warn|error|trace)\(|\bprintln\(`,
            ),
        ),
        sink(
            'scala.response.error-detail',
            'data_exposure',
            'CWE-209',
            String.raw`\b(?:InternalServerError|BadRequest|Ok|complete)\([^)]*\b(?:e|ex|t|err|error)\.(?:getMessage|getStackTrace|toString|printStackTrace)\b|\.printStackTrace\(\)`,
        ),
        sink(
            'scala.response.whole-entity',
            'data_exposure',
            'CWE-200',
            String.raw`\bOk\(\s*Json\.toJson\(\s*(?:user|users|account)\s*\)\s*\)`,
            'play',
        ),
        ...jcaCrypto('scala'),
        sink(
            'scala.crypto.insecure-random-util',
            'secret_identity',
            'CWE-338',
            randomForSecret(
                String.raw`\bRandom\.(?:alphanumeric|nextString|nextInt|nextLong)\b|\bnew\s+Random\(`,
            ),
        ),
        timingCompare('scala', JVM_EQUALS_COMPARE),
        ...commonSinks('scala', { nosql: true }),
    ],
};
