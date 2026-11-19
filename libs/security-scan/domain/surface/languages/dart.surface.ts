import { LanguageSurface } from '../surface.types';
import {
    any,
    auth,
    commonSinks,
    entry,
    logsSensitive,
    sink,
    sqlConcat,
    sqlInString,
    timingCompare,
} from './shared';

/** Dart interpolation `$x` / `${x}` (`$1` is not one). */
const INTERP = String.raw`\$\{?[a-zA-Z_]`;
const VAR_ARG = String.raw`(?:[a-z_]\w*(?:\.\w+)*\s*[,)]|'[^']*${INTERP}|"[^"]*${INTERP})`;
const REQ = String.raw`(?:\brequest\.|\bparams\[|\bcontext\.request\b|\breq\.)`;

export const DART_SURFACE: LanguageSurface = {
    language: 'dart',
    glob: '*.dart',
    patterns: [
        entry(
            'dart.shelf.route',
            String.raw`\b\w*[Rr]outer\.(?:get|post|put|patch|delete|all|mount|add)\(\s*['"]|@Route\.(?:get|post|put|delete|patch|all|mount)\(`,
            'shelf_router',
        ),
        entry(
            'dart.shelf.handler',
            String.raw`\b(?:Future<)?Response>?\s+\w+\(\s*Request\s+\w+|\bshelf_io\.serve\(|\bHttpServer\.bind\(`,
            'shelf',
        ),
        entry(
            'dart.frog.handler',
            String.raw`\bonRequest\(\s*RequestContext\b`,
            'dart_frog',
        ),
        entry(
            'dart.flutter.deep-link',
            String.raw`\b(?:uriLinkStream|getInitialLink\(|getInitialUri\(|appLinks\.\w+)`,
            'flutter',
        ),
        entry(
            'dart.cli.args',
            String.raw`\bmain\(\s*List<String>\s+\w+\s*\)|\bArgParser\(\)`,
            'cli',
        ),

        auth(
            'dart.auth',
            String.raw`\bJWT\.verify\(|\b(?:bearerAuthentication|basicAuthentication)\s*<|\.addMiddleware\(\s*\w*[Aa]uth|\b(?:requireAuth|checkAuth|authMiddleware|verifyToken|isAuthenticated)\b|\bFirebaseAuth\.instance\.currentUser\b`,
        ),

        sink(
            'dart.sql.string-built',
            'injection',
            'CWE-89',
            any(
                sqlConcat(),
                sqlInString('"', INTERP),
                sqlInString("'", INTERP),
            ),
        ),
        sink(
            'dart.sql.raw-call',
            'injection',
            'CWE-89',
            String.raw`\.(?:rawQuery|rawInsert|rawUpdate|rawDelete|execute|query)\(\s*[a-z]\w*\s*\)`,
            'sqflite/postgres',
        ),
        sink(
            'dart.exec',
            'injection',
            'CWE-78',
            String.raw`\bProcess\.(?:run|runSync|start)\(\s*(?:['"](?:sh|bash|/bin/sh|/bin/bash|cmd|powershell)['"]|[a-z]\w*\s*,)|\bProcess\.(?:run|runSync|start)\([^)]*\brunInShell:\s*true`,
        ),
        sink(
            'dart.webview.eval',
            'injection',
            'CWE-94',
            String.raw`\.run(?:Java[Ss]cript|JavaScriptReturningResult)\(\s*(?:[a-z]\w*\s*\)|'[^']*${INTERP}|"[^"]*${INTERP})`,
            'webview_flutter',
        ),
        sink(
            'dart.path.traversal',
            'injection',
            'CWE-22',
            String.raw`\bFile\([^)]*${REQ}|\bFile\(\s*['"][^'"]*\$\{?(?:request|params|req)\b|\bp\.join\([^)]*${REQ}`,
        ),
        sink(
            'dart.http.variable-url',
            'ssrf',
            'CWE-918',
            String.raw`\bhttp\.(?:get|post|put|patch|delete|head|read)\(\s*(?:Uri\.parse\(\s*)?${VAR_ARG}|\bdio\.(?:get|post|put|delete|request)\(\s*${VAR_ARG}|\.(?:getUrl|postUrl|openUrl)\(\s*(?:Uri\.parse\(\s*)?${VAR_ARG}`,
            'http/dio',
        ),
        sink(
            'dart.lookup.by-route-id',
            'authz',
            'CWE-639',
            String.raw`\bonRequest\(\s*RequestContext\s+\w+\s*,\s*String\s+\w*[iI]d\b|\bwhere:\s*['"](?:\w+\.)?id\s*=\s*\?['"]`,
            'dart_frog/sqflite',
        ),
        sink(
            'dart.log.sensitive',
            'data_exposure',
            'CWE-532',
            logsSensitive(
                String.raw`\b(?:print|debugPrint|log|developer\.log)\(|\b_?logger\.(?:i|d|w|e|v|info|fine|warning|severe|debug|error)\(`,
            ),
        ),
        sink(
            'dart.storage.plaintext-secret',
            'data_exposure',
            'CWE-312',
            String.raw`\.setString\(\s*['"]\w*(?:[Tt]oken|[Pp]assword|[Ss]ecret)`,
            'shared_preferences',
        ),
        sink(
            'dart.response.error-detail',
            'data_exposure',
            'CWE-209',
            String.raw`\bResponse\.internalServerError\([^)]*\b(?:e|error|err|st|stackTrace)\b|\bstackTrace\.toString\(\)`,
            'shelf',
        ),
        sink(
            'dart.crypto.weak-hash',
            'secret_identity',
            'CWE-328',
            String.raw`\b(?:md5|sha1)\.convert\(`,
        ),
        sink(
            'dart.crypto.weak-cipher',
            'secret_identity',
            'CWE-327',
            String.raw`\bAESMode\.ecb\b`,
        ),
        sink(
            'dart.crypto.insecure-random',
            'secret_identity',
            'CWE-338',
            // Random() is not cryptographic; Random.secure() is.
            String.raw`(?:[Tt]oken|[Ss]ecret|[Nn]once|[Ss]alt|[Oo]tp|[Pp]assword|[Cc]ode|[Cc]hars|[Aa]lphabet)\w*.*\bRandom\(\)`,
        ),
        timingCompare('dart'),
        sink(
            'dart.jwt.unverified',
            'secret_identity',
            'CWE-347',
            String.raw`\bJWT\.decode\(`,
            'dart_jsonwebtoken',
        ),
        sink(
            'dart.tls.verification-disabled',
            'secret_identity',
            'CWE-295',
            String.raw`\b(?:badCertificateCallback|onBadCertificate)\s*=\s*\([^)]*\)\s*(?:=>\s*true|\{\s*return\s+true)`,
        ),
        ...commonSinks('dart', { xpath: false, ldap: false }),
    ],
};
