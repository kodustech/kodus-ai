import { SurfacePattern } from '../surface.types';
import {
    any,
    auth,
    commonSinks,
    entry,
    logsSensitive,
    randomForSecret,
    sink,
    SQL_SHAPE,
} from './shared';

/** An lvalue-ish C expression: `buf`, `req->path`, `argv[1]`, `url.c_str()`. */
const C_EXPR = String.raw`[a-z_][\w.>()\[\]-]*`;

/**
 * Patterns shared by C and C++. Memory-safety bugs (strcpy, gets, overflows)
 * are outside the five classes and deliberately left out; format strings and
 * command/SQL strings built with printf are injection.
 */
export function cFamilyPatterns(prefix: string): SurfacePattern[] {
    return [
        entry(`${prefix}.main`, String.raw`\bint\s+main\s*\(`, 'posix'),
        entry(
            `${prefix}.socket.recv`,
            String.raw`\b(?:recv|recvfrom|recvmsg|accept|accept4)\(`,
            'posix',
        ),
        entry(
            `${prefix}.cgi.env`,
            String.raw`\bgetenv\(\s*"(?:QUERY_STRING|REQUEST_METHOD|CONTENT_LENGTH|HTTP_\w+|PATH_INFO|REMOTE_\w+)"|\bFCGI_Accept\(`,
            'cgi',
        ),
        entry(
            `${prefix}.stdin`,
            String.raw`\bscanf\(|\b(?:fgets|getline)\(.*\bstdin\b`,
            'posix',
        ),
        entry(
            `${prefix}.http.embedded`,
            String.raw`\bMHD_start_daemon\(|\bMHD_get_connection_value\(|\bmg_http_listen\(|\bmg_http_match_uri\(`,
            'libmicrohttpd/mongoose',
        ),

        auth(
            `${prefix}.auth`,
            String.raw`\b(?:pam_authenticate|pam_acct_mgmt|crypt_r|crypt|verify_password|check_password|SSL_get_verify_result|X509_verify_cert|getuid|geteuid|setuid|seteuid)\s*\(`,
            'posix/pam/openssl',
        ),

        sink(
            `${prefix}.exec.shell`,
            'injection',
            'CWE-78',
            String.raw`\b(?:system|popen|_popen|_wsystem|wordexp)\(\s*[^")\s]|\bexec(?:l|lp|le|v|vp|vpe|ve)\(\s*(?:"/bin/(?:ba)?sh"|[a-z_][\w\[\]]*\s*,)`,
        ),
        sink(
            `${prefix}.exec.command-format`,
            'injection',
            'CWE-78',
            String.raw`"[^"]*\b(?:ping|nslookup|curl|wget|rm|cp|mv|tar|unzip|convert|ffmpeg|sh|bash)\s[^"]*%s`,
        ),
        sink(
            `${prefix}.format-string`,
            'injection',
            'CWE-134',
            String.raw`\bprintf\(\s*${C_EXPR}\s*\)|\b(?:fprintf|sprintf|syslog|dprintf)\(\s*[\w.>-]+\s*,\s*${C_EXPR}\s*\)|\bsnprintf\(\s*[\w.>-]+\s*,\s*[^,]+,\s*${C_EXPR}\s*\)`,
        ),
        sink(
            `${prefix}.sql.string-built`,
            'injection',
            'CWE-89',
            any(
                String.raw`\b(?:sprintf|snprintf|asprintf)\([^;]*"[^"]*${SQL_SHAPE}[^"]*%s`,
                String.raw`\b(?:sqlite3_exec|mysql_query|mysql_real_query|PQexec)\(\s*[\w.>-]+\s*,\s*${C_EXPR}\s*[,)]`,
            ),
        ),
        sink(
            `${prefix}.path.traversal`,
            'injection',
            'CWE-22',
            String.raw`\b(?:fopen|open|unlink|remove|opendir|realpath)\([^)]*(?:\bgetenv\(|\bargv\[|\bquery|QUERY_STRING|\bpath_info|\buri\b|\burl\b)`,
        ),
        sink(
            `${prefix}.http.variable-url`,
            'ssrf',
            'CWE-918',
            String.raw`\bCURLOPT_URL\s*,\s*${C_EXPR}\s*\)`,
            'libcurl',
        ),
        sink(
            `${prefix}.log.sensitive`,
            'data_exposure',
            'CWE-532',
            logsSensitive(
                String.raw`\b(?:printf|fprintf|syslog|puts|fputs)\(|\bstd::(?:cout|cerr|clog)\b|\bspdlog::\w+\(|\bLOG\(\w+\)`,
            ),
        ),
        sink(
            `${prefix}.secret.define`,
            'secret_identity',
            'CWE-798',
            String.raw`#define\s+\w*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY)\w*\s+"[^"\s]{8,}"`,
        ),
        sink(
            `${prefix}.crypto.weak-hash`,
            'secret_identity',
            'CWE-328',
            String.raw`\b(?:MD5|MD4|SHA1)(?:_Init|_Update|_Final)?\(|\bEVP_(?:md5|sha1|md4)\(\)`,
            'openssl',
        ),
        sink(
            `${prefix}.crypto.weak-cipher`,
            'secret_identity',
            'CWE-327',
            String.raw`\bEVP_(?:des|rc4|bf|rc2)\w*\(\)|\bEVP_aes_\d+_ecb\(\)|\bDES_\w+\(`,
            'openssl',
        ),
        sink(
            `${prefix}.crypto.insecure-random`,
            'secret_identity',
            'CWE-338',
            any(
                randomForSecret(
                    String.raw`\b(?:rand|random|drand48|lrand48)\(\)|\bstd::(?:rand|mt19937)\b`,
                ),
                String.raw`\bsrand\(\s*(?:\(\w+\)\s*)?time\(`,
            ),
        ),
        sink(
            `${prefix}.crypto.timing-unsafe-compare`,
            'secret_identity',
            'CWE-208',
            // CRYPTO_memcmp has a word char before `memcmp`, so `\b` keeps it out.
            String.raw`\b(?:memcmp|strcmp|strncmp)\([^)]*(?:[Tt]oken|[Ss]ecret|[Pp]ass(?:word|wd)?|[Hh]mac|[Mm]ac|[Ss]ig(?:nature)?|[Dd]igest|[Hh]ash)`,
        ),
        sink(
            `${prefix}.tls.verification-disabled`,
            'secret_identity',
            'CWE-295',
            String.raw`\bSSL_CTX_set_verify\(\s*[\w.>-]+\s*,\s*SSL_VERIFY_NONE|\bCURLOPT_SSL_VERIFY(?:PEER|HOST)\s*,\s*0L?\b`,
        ),
        ...commonSinks(prefix, { ldap: false, xpath: false }),
    ];
}
