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

const INTERP = String.raw`#\{`;
const VAR_ARG = String.raw`(?:[a-z_]\w*(?:\.\w+)*\s*[,)]|"[^"]*#\{)`;

export const ELIXIR_SURFACE: LanguageSurface = {
    language: 'elixir',
    glob: '*.{ex,exs}',
    patterns: [
        entry(
            'ex.phoenix.route',
            String.raw`^\s*(?:get|post|put|patch|delete|options|head|forward|resources|live|scope)\s+"/`,
            'phoenix',
        ),
        entry(
            'ex.phoenix.action',
            String.raw`\bdef\s+\w+\(\s*(?:%Plug\.Conn\{\}\s*=\s*)?conn\s*,`,
            'phoenix/plug',
        ),
        entry(
            'ex.phoenix.live-channel',
            String.raw`\bdef\s+handle_event\(|\bdef\s+handle_in\(|\bdef\s+join\(\s*"`,
            'phoenix',
        ),
        entry(
            'ex.consumer',
            String.raw`\buse\s+(?:Broadway|GenStage|Oban\.Worker|Kaffe\.\w+)\b|\bdef\s+handle_message\(`,
            'broadway/oban',
        ),
        entry(
            'ex.cli',
            String.raw`\bSystem\.argv\(\)|\bOptionParser\.parse`,
            'cli',
        ),

        auth(
            'ex.auth',
            String.raw`\bpipe_through\b.*\b(?:auth\w*|require_\w+|ensure_\w+|authenticated|admin|protected)\b|\bplug\s+:?[\w.]*(?:[Aa]uth|Guardian|ensure_|require_|Require|Ensure|current_user)|\bon_mount\b.*(?:[Aa]uth|ensure_|require_)|\bGuardian\.Plug\.\w+`,
            'phoenix/guardian',
        ),

        sink(
            'ex.sql.string-built',
            'injection',
            'CWE-89',
            any(sqlConcat(String.raw`<>`), sqlInString('"', INTERP)),
        ),
        sink(
            'ex.sql.raw-call',
            'injection',
            'CWE-89',
            String.raw`\bfragment\(\s*"[^"]*#\{|\b(?:Repo|Ecto\.Adapters\.SQL)\.query!?\(\s*(?:\w+\s*,\s*)?(?:[a-z_]\w*\s*[,)]|"[^"]*#\{)`,
            'ecto',
        ),
        sink(
            'ex.exec',
            'injection',
            'CWE-78',
            String.raw`\bSystem\.cmd\(\s*"(?:sh|bash|/bin/sh|/bin/bash)"|\bSystem\.shell\(|:os\.cmd\(|\bPort\.open\(\s*\{\s*:spawn\s*,`,
        ),
        sink(
            'ex.eval',
            'injection',
            'CWE-94',
            String.raw`\bCode\.(?:eval_string|eval_quoted|eval_file|compile_string)\(`,
        ),
        sink(
            'ex.template.injection',
            'injection',
            'CWE-1336',
            String.raw`\bEEx\.eval_string\(\s*[a-z_]`,
        ),
        sink(
            'ex.deserialize',
            'injection',
            'CWE-502',
            String.raw`:erlang\.binary_to_term\(|\bPlug\.Crypto\.non_executable_binary_to_term\(`,
        ),
        sink(
            'ex.path.traversal',
            'injection',
            'CWE-22',
            String.raw`\b(?:File\.(?:read!?|write!?|rm!?|rm_rf!?|stream!|open!?|cp!?)|send_file|Plug\.Conn\.send_file)\([^)]*(?:params\[|conn\.params|\bparams\b|#\{)|\bPath\.join\([^)]*(?:params\[|conn\.params)|\bsend_download\(\s*conn\s*,\s*\{\s*:file\s*,\s*[a-z_]`,
        ),
        sink(
            'ex.http.variable-url',
            'ssrf',
            'CWE-918',
            String.raw`\b(?:HTTPoison|Req|Tesla|HTTPotion|:httpc)\.(?:get|post|put|patch|delete|request|head)!?\(\s*(?::\w+\s*,\s*)?${VAR_ARG}|\bFinch\.build\(\s*:\w+\s*,\s*${VAR_ARG}`,
            'httpoison/req/tesla/finch',
        ),
        sink(
            'ex.repo.by-id-only',
            'authz',
            'CWE-639',
            // Phoenix generators emit `Repo.get!(Post, id)` / `get_post!(id)`:
            // unscoped unless the context adds the user.
            String.raw`\bRepo\.get!?\(\s*[\w.]+\s*,\s*[\w"\[\]]+\s*\)|\.get_\w+!\(\s*(?:id|params\["id"\])\s*\)`,
            'ecto',
        ),
        sink(
            'ex.log.sensitive',
            'data_exposure',
            'CWE-532',
            logsSensitive(
                String.raw`\bLogger\.(?:debug|info|notice|warn|warning|error)\(|\bIO\.(?:puts|inspect)\(`,
            ),
        ),
        sink(
            'ex.response.error-detail',
            'data_exposure',
            'CWE-209',
            String.raw`\bdebug_errors:\s*true|\b(?:send_resp|json|text)\([^)]*(?:inspect\(\s*(?:e|err|error|reason|exception)\s*\)|Exception\.message\()`,
        ),
        sink(
            'ex.response.whole-entity',
            'data_exposure',
            'CWE-200',
            String.raw`@derive\s+Jason\.Encoder\s*$|\bjson\(\s*conn\s*,\s*(?:user|users|account)\s*\)`,
        ),
        sink(
            'ex.crypto.weak-hash',
            'secret_identity',
            'CWE-328',
            String.raw`:crypto\.hash\(\s*:(?:md5|sha|md4)\b|:crypto\.(?:md5|sha)\(`,
        ),
        sink(
            'ex.crypto.weak-cipher',
            'secret_identity',
            'CWE-327',
            String.raw`:crypto\.(?:crypto_one_time|block_encrypt|crypto_init)\(\s*:(?:des\w*|rc4|aes_\d+_ecb|blowfish\w*)`,
        ),
        sink(
            'ex.crypto.insecure-random',
            'secret_identity',
            'CWE-338',
            randomForSecret(
                String.raw`:rand\.uniform\(|\bEnum\.random\(|:random\.uniform\(`,
            ),
        ),
        timingCompare('ex'),
        sink(
            'ex.jwt.unverified',
            'secret_identity',
            'CWE-347',
            String.raw`\bJoken\.peek\w*\(|\bJOSE\.JWT\.peek\w*\(`,
            'joken/jose',
        ),
        sink(
            'ex.tls.verification-disabled',
            'secret_identity',
            'CWE-295',
            String.raw`\bverify:\s*:verify_none\b`,
        ),
        ...commonSinks('ex', { xpath: false }),
    ],
};
