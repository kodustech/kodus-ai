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

/**
 * Swift interpolation `\(x)`. SQLKit's `\(bind: x)` is parameterized, so only
 * a bare identifier or `unsafeRaw:` counts.
 */
const INTERP = String.raw`\\\((?:[a-zA-Z_][\w.]*\s*\)|unsafeRaw:)`;
const VAR_ARG = String.raw`(?:[a-z_]\w*(?:\.\w+)*\s*[,)]|"[^"]*\\\()`;

export const SWIFT_SURFACE: LanguageSurface = {
    language: 'swift',
    glob: '*.swift',
    patterns: [
        entry(
            'swift.vapor.route',
            String.raw`\b\w+\.(?:get|post|put|patch|delete)\(\s*"[\w:/*-]*"\s*[,)]|\b\w+\.on\(\s*\.(?:GET|POST|PUT|PATCH|DELETE)\b`,
            'vapor',
        ),
        entry(
            'swift.vapor.collection',
            String.raw`:\s*RouteCollection\b|\bfunc\s+boot\(\s*routes\s*:`,
            'vapor',
        ),
        entry(
            'swift.vapor.handler',
            String.raw`\(\s*req\s*:\s*Request\s*\)\s*(?:async\s+)?(?:throws\s+)?->`,
            'vapor',
        ),
        entry(
            'swift.ios.url-open',
            String.raw`\bopen\s+url\s*:\s*URL\b|\.onOpenURL\s*\{|\bcontinue\s+userActivity\b`,
            'ios',
        ),
        entry(
            'swift.cli',
            String.raw`\bCommandLine\.arguments\b|:\s*(?:Async)?ParsableCommand\b`,
            'cli',
        ),

        auth(
            'swift.vapor.auth',
            String.raw`\.grouped\([^)]*(?:Authenticator|authenticator\(\)|GuardMiddleware|guardMiddleware\(\))|\breq\.auth\.require\(|:\s*(?:Async)?(?:Bearer|Basic|Credentials|Request)?Authenticator\b|\bModelAuthenticatable\b|\breq\.jwt\.verify\(`,
            'vapor',
        ),

        sink(
            'swift.sql.string-built',
            'injection',
            'CWE-89',
            any(sqlConcat(), sqlInString('"', INTERP)),
        ),
        sink(
            'swift.sql.raw-call',
            'injection',
            'CWE-89',
            String.raw`\bsqlite3_exec\(\s*\w+\s*,\s*[a-z]\w*\s*,|\.raw\(\s*SQLQueryString\(\s*[a-z]`,
        ),
        sink(
            'swift.exec',
            'injection',
            'CWE-78',
            String.raw`\blaunchPath\s*=\s*"/bin/(?:ba|z)?sh"|\bexecutableURL\s*=\s*URL\(fileURLWithPath:\s*"/bin/(?:ba|z)?sh"|\barguments\s*=\s*\[\s*"-c"\s*,|\bsystem\(\s*[a-z]|\bposix_spawn\(`,
        ),
        sink(
            'swift.eval',
            'injection',
            'CWE-94',
            String.raw`\bNSExpression\(format:\s*(?:[a-z]|"[^"]*\\\()|\.evaluateScript\(\s*(?:[a-z]|"[^"]*\\\()|\.evaluateJavaScript\(\s*(?:[a-z]|"[^"]*\\\()`,
        ),
        sink(
            'swift.predicate.injection',
            'injection',
            'CWE-943',
            String.raw`\bNSPredicate\(format:\s*(?:[a-z]|"[^"]*\\\()`,
            'foundation/coredata',
        ),
        sink(
            'swift.path.traversal',
            'injection',
            'CWE-22',
            String.raw`\bstreamFile\(at:\s*(?:[a-z]|"[^"]*\\\()|\.appendingPathComponent\(\s*(?:req\.|filename\s*\)|fileName\s*\)|name\s*\))|\bFileManager\.default\.(?:contents|removeItem|createFile)\(atPath:\s*(?:"[^"]*\\\(|[^)]*req\.)`,
        ),
        sink(
            'swift.http.variable-url',
            'ssrf',
            'CWE-918',
            String.raw`\bURL\(string:\s*${VAR_ARG}|\breq\.client\.(?:get|post|put|delete|send)\(\s*(?:URI\(string:\s*)?${VAR_ARG}|\bAF\.request\(\s*${VAR_ARG}|\bURLRequest\(url:\s*URL\(string:\s*${VAR_ARG}`,
            'foundation/vapor/alamofire',
        ),
        sink(
            'swift.orm.by-id-only',
            'authz',
            'CWE-639',
            String.raw`\.find\(\s*req\.parameters\.get\(|\.filter\(\s*\\\.\$id\s*==\s*[\w.]+\s*\)\.first\(`,
            'vapor-fluent',
        ),
        sink(
            'swift.log.sensitive',
            'data_exposure',
            'CWE-532',
            logsSensitive(
                String.raw`\b(?:print|NSLog|debugPrint|os_log)\(|\b(?:logger|req\.logger|log)\.(?:info|debug|notice|warning|error|critical|trace)\(`,
            ),
        ),
        sink(
            'swift.storage.plaintext-secret',
            'data_exposure',
            'CWE-312',
            String.raw`\bUserDefaults\.standard\.set\([^)]*(?:[Tt]oken|[Pp]assword|[Ss]ecret|[Aa]pi[Kk]ey)`,
            'ios',
        ),
        sink(
            'swift.response.error-detail',
            'data_exposure',
            'CWE-209',
            String.raw`\bAbort\([^)]*reason:\s*(?:"[^"]*\\\(error\)|(?:error|err|e)\.localizedDescription|String\(describing:\s*error\))`,
            'vapor',
        ),
        sink(
            'swift.response.whole-entity',
            'data_exposure',
            'CWE-200',
            String.raw`->\s*(?:EventLoopFuture<\s*)?\[?User\]?\s*>?\s*\{`,
            'vapor',
        ),
        sink(
            'swift.crypto.weak-hash',
            'secret_identity',
            'CWE-328',
            String.raw`\bInsecure\.(?:MD5|SHA1)\b|\bCC_(?:MD5|SHA1)\(`,
        ),
        sink(
            'swift.crypto.weak-cipher',
            'secret_identity',
            'CWE-327',
            String.raw`\bkCCAlgorithm(?:DES|3DES|RC4|RC2|Blowfish)\b|\bkCCOptionECBMode\b`,
        ),
        sink(
            'swift.crypto.insecure-random',
            'secret_identity',
            'CWE-338',
            // Int.random/arc4random are secure on Apple platforms; C rand() is not.
            randomForSecret(String.raw`\b(?:rand|random|drand48)\(\)`),
        ),
        timingCompare('swift'),
        sink(
            'swift.jwt.unverified',
            'secret_identity',
            'CWE-347',
            String.raw`\.unverified\b|\bdecode\(jwt:`,
        ),
        sink(
            'swift.tls.verification-disabled',
            'secret_identity',
            'CWE-295',
            String.raw`\bURLCredential\(trust:\s*\w+\.protectionSpace\.serverTrust|\bDisabledTrustEvaluator\(\)|\bDisabledEvaluator\(\)`,
        ),
        ...commonSinks('swift', { xpath: false }),
    ],
};
