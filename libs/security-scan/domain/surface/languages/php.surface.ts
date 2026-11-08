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

/** Double-quoted interpolation: `"$x"` / `"{$x}"`. */
const INTERP = String.raw`(?:\$[a-zA-Z_]|\{\$)`;
const SUPERGLOBAL = String.raw`\$_(?:GET|POST|REQUEST|COOKIE|FILES)\b`;
/** A value built from a variable: `$x`, `'..' . $x`, or `"..$x"`. */
const VAR_ARG = String.raw`(?:\$\w|'[^']*'\s*\.\s*\$|"[^"]*"\s*\.\s*\$|"[^"]*${INTERP})`;
/** `exec(` but not `$pdo->exec(` or `Foo::exec(`. */
const NOT_METHOD = String.raw`(?:^|[^>\w:$])`;

export const PHP_SURFACE: LanguageSurface = {
    language: 'php',
    glob: '*.php',
    patterns: [
        entry(
            'php.laravel.route',
            String.raw`\bRoute::(?:get|post|put|patch|delete|any|match|resource|apiResource|group|prefix|controller)\(`,
            'laravel',
        ),
        entry('php.symfony.route', String.raw`#\[Route\(|@Route\(`, 'symfony'),
        entry(
            'php.slim.route',
            String.raw`\$(?:app|router|group|r)->(?:get|post|put|patch|delete|map|any)\(\s*['"]/`,
            'slim/lumen',
        ),
        entry(
            'php.controller.action',
            String.raw`\bpublic\s+function\s+\w+\([^)]*\b\w*Request\s+\$\w+`,
            'laravel/symfony',
        ),
        entry(
            'php.superglobal',
            String.raw`${SUPERGLOBAL}|\$_SERVER\[\s*['"](?:QUERY_STRING|REQUEST_URI|PATH_INFO|HTTP_\w+)['"]|\bfile_get_contents\(\s*['"]php://input['"]`,
            'php',
        ),
        entry(
            'php.wordpress.hook',
            String.raw`\badd_action\(\s*['"](?:wp_ajax_|admin_post_)|\bregister_rest_route\(`,
            'wordpress',
        ),
        entry(
            'php.cli',
            String.raw`\$argv\b|\$_SERVER\[\s*['"]argv['"]\]|\bgetopt\(`,
            'cli',
        ),

        auth(
            'php.auth',
            String.raw`->middleware\(\s*\[?\s*['"](?:auth|can:|role:|permission:|verified|abilities|ability)|\bAuth::(?:check|user|guard|id|attempt)\(|\$this->authorize\(|\bGate::(?:allows|denies|authorize|define)\(|#\[IsGranted\(|@IsGranted\(|->denyAccessUnlessGranted\(|\bisGranted\(|\bcurrent_user_can\(|\bcheck_ajax_referer\(|\bwp_verify_nonce\(|\bis_user_logged_in\(`,
            'laravel/symfony/wordpress',
        ),

        sink(
            'php.sql.string-built',
            'injection',
            'CWE-89',
            any(sqlConcat(String.raw`\.\s*\$`), sqlInString('"', INTERP)),
        ),
        sink(
            'php.sql.raw-call',
            'injection',
            'CWE-89',
            String.raw`\b(?:mysqli_query|mysql_query|pg_query|sqlite_query)\([^;]*(?:"[^"]*${INTERP}|['"]\s*\.\s*\$|${SUPERGLOBAL})|->(?:query|exec|whereRaw|orderByRaw|selectRaw|havingRaw|raw)\(\s*(?:"[^"]*${INTERP}|'[^']*'\s*\.\s*\$|"[^"]*"\s*\.\s*\$|\$\w+\s*\.)|\bDB::(?:select|statement|unprepared|raw|insert|update|delete)\(\s*(?:"[^"]*${INTERP}|'[^']*'\s*\.\s*\$|"[^"]*"\s*\.\s*\$)|\bDB::unprepared\(`,
        ),
        sink(
            'php.exec',
            'injection',
            'CWE-78',
            // `exec('ls ' . escapeshellarg($d))`: the concat must hit a bare `$`.
            String.raw`${NOT_METHOD}(?:system|exec|shell_exec|passthru|popen|proc_open|pcntl_exec)\(\s*(?:[^)'"]*\$|'[^']*'\s*\.\s*\$|"[^"]*"\s*\.\s*\$|"[^"]*${INTERP})|\x60[^\x60]*\$[a-zA-Z_{]`,
        ),
        sink(
            'php.eval',
            'injection',
            'CWE-94',
            String.raw`${NOT_METHOD}(?:eval|assert|create_function)\(\s*[^)'"]*\$|\bpreg_replace\(\s*['"][^'"]*/[a-zA-Z]*e[a-zA-Z]*['"]`,
        ),
        sink(
            'php.deserialize',
            'injection',
            'CWE-502',
            String.raw`\bunserialize\(\s*(?:\$|base64_decode\()`,
        ),
        sink(
            'php.include',
            'injection',
            'CWE-98',
            String.raw`\b(?:include|require)(?:_once)?\s*\(?\s*[^;'"]*\$`,
        ),
        sink(
            'php.template.injection',
            'injection',
            'CWE-1336',
            String.raw`->(?:createTemplate|renderString)\(\s*\$|\bBlade::(?:render|compileString)\(\s*\$|->fetch\(\s*['"]string:`,
        ),
        sink(
            'php.path.traversal',
            'injection',
            'CWE-22',
            String.raw`\b(?:file_get_contents|fopen|readfile|file|unlink|file_put_contents|fpassthru|copy|rename|rmdir|mkdir|is_file|file_exists|move_uploaded_file)\(\s*[^)]*${SUPERGLOBAL}|->(?:download|file)\(\s*[^)]*\$request->|\bStorage::(?:get|download|delete)\(\s*\$request->`,
        ),
        sink(
            'php.nosql.operator-injection',
            'injection',
            'CWE-943',
            String.raw`->(?:find|findOne|aggregate|count|countDocuments|deleteOne|deleteMany|updateOne|updateMany)\(\s*${SUPERGLOBAL}`,
            'mongodb',
        ),
        sink(
            'php.http.variable-url',
            'ssrf',
            'CWE-918',
            String.raw`\b(?:file_get_contents|fopen|curl_init|get_headers|fsockopen|simplexml_load_file)\(\s*${VAR_ARG}|\bCURLOPT_URL\s*,\s*${VAR_ARG}|\bHttp::(?:\w+\([^)]*\)->)*(?:get|post|put|patch|delete|send)\(\s*${VAR_ARG}|\$(?:client|http|guzzle|httpClient)\w*->(?:request|get|post|put|delete|send|requestAsync)\(\s*(?:['"](?:GET|POST|PUT|DELETE|PATCH)['"]\s*,\s*)?${VAR_ARG}`,
            'curl/guzzle/laravel-http',
        ),
        sink(
            'php.orm.by-id-only',
            'authz',
            'CWE-639',
            String.raw`\b[A-Z]\w*::(?:find|findOrFail|destroy|whereKey)\(\s*\$(?:id|request|\w+Id|\w+_id)\b|\b[A-Z]\w*::where\(\s*['"]id['"]\s*,\s*\$\w+\s*\)->(?:first|firstOrFail|get|delete|update)\(|->find\(\s*${SUPERGLOBAL}`,
            'laravel/doctrine',
        ),
        sink(
            'php.route-model-binding',
            'authz',
            'CWE-639',
            // Implicit binding resolves `Invoice $invoice` by id from the URL;
            // the action must authorize it itself.
            String.raw`\bpublic\s+function\s+(?:show|edit|update|destroy|delete|download)\(\s*(?:\w*Request\s+\$\w+\s*,\s*)?[A-Z]\w+\s+\$\w+\s*\)`,
            'laravel',
        ),
        sink(
            'php.log.sensitive',
            'data_exposure',
            'CWE-532',
            logsSensitive(
                String.raw`\bLog::\w+\(|\blogger\(\)->\w+\(|->logger->\w+\(|\$logger->\w+\(|\berror_log\(|\bvar_dump\(|\bprint_r\(`,
            ),
        ),
        sink(
            'php.response.error-detail',
            'data_exposure',
            'CWE-209',
            String.raw`\bini_set\(\s*['"]display_errors['"]\s*,\s*['"]?(?:1|On|on|true)|\becho\s+\$e(?:x|xception)?->getMessage\(\)|->getTraceAsString\(\)|\bphpinfo\(\)`,
        ),
        sink(
            'php.response.whole-entity',
            'data_exposure',
            'CWE-200',
            String.raw`\breturn\s+response\(\)->json\(\s*\$(?:user|users|account)\s*\)|\bjson_encode\(\s*\$(?:user|users|account)\s*\)|\bprotected\s+\$hidden\s*=\s*\[\s*\]`,
        ),
        sink(
            'php.crypto.weak-hash',
            'secret_identity',
            'CWE-328',
            String.raw`\b(?:md5|sha1)\(\s*\$|\bhash\(\s*['"](?:md5|sha1)['"]`,
        ),
        sink(
            'php.crypto.weak-cipher',
            'secret_identity',
            'CWE-327',
            String.raw`\bopenssl_encrypt\([^,]+,\s*['"](?:[Dd][Ee][Ss]|[Rr][Cc]4|[Bb][Ff]|[^'"]*-[Ee][Cc][Bb])|\bmcrypt_\w+\(`,
        ),
        sink(
            'php.crypto.insecure-random',
            'secret_identity',
            'CWE-338',
            randomForSecret(
                String.raw`\b(?:rand|mt_rand|uniqid|lcg_value|str_shuffle|array_rand)\(`,
            ),
        ),
        timingCompare(
            'php',
            String.raw`\bstrcmp\([^)]*(?:[Tt]oken|[Ss]ecret|[Ss]ignature|[Hh]mac|[Hh]ash|[Pp]assword)`,
        ),
        sink(
            'php.jwt.unverified',
            'secret_identity',
            'CWE-347',
            String.raw`->parse\(\s*\$\w+\s*\)->claims\(\)|\bJWT::decode\(\s*\$\w+\s*\)`,
            'lcobucci/firebase-jwt',
        ),
        sink(
            'php.tls.verification-disabled',
            'secret_identity',
            'CWE-295',
            String.raw`\bCURLOPT_SSL_VERIFY(?:PEER|HOST)\s*,\s*(?:false|0)\b|['"]verify['"]\s*=>\s*false|->withoutVerifying\(\)`,
        ),
        ...commonSinks('php', { nosql: true }),
    ],
};
