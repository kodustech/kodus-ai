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
/** Ruby allows paren-less calls: `HTTParty.get url`. */
const VAR_ARG = String.raw`(?:[a-z_@]\w*|params\b|"[^"]*#\{|URI\(\s*[a-z_@])`;

export const RUBY_SURFACE: LanguageSurface = {
    language: 'ruby',
    glob: '*.{rb,rake}',
    extraGlobs: [
        {
            glob: '**/{routes.rb,routes/**/*.rb}',
            patterns: [
                entry(
                    'rb.rails.routes',
                    String.raw`^\s*(?:get|post|put|patch|delete|match|resources?|root|namespace|scope|mount)\b`,
                    'rails',
                ),
            ],
        },
    ],
    patterns: [
        entry(
            'rb.rails.controller',
            String.raw`\bclass\s+[\w:]+Controller\s*<|\bclass\s+\w+\s*<\s*(?:[\w:]*::)?(?:Application|Base|Action|Api)Controller\b`,
            'rails',
        ),
        entry(
            'rb.sinatra.route',
            String.raw`^\s*(?:get|post|put|patch|delete)\s+(?:['"][^'"]*['"]|:\w+)?\s*(?:do\b|\{)`,
            'sinatra/grape',
        ),
        entry(
            'rb.graphql',
            String.raw`<\s*(?:GraphQL::Schema::(?:Mutation|Resolver|RelayClassicMutation)|Mutations::Base\w+|Resolvers::Base\w+|Base(?:Mutation|Resolver))\b`,
            'graphql-ruby',
        ),
        entry(
            'rb.job.consumer',
            String.raw`\binclude\s+(?:Sidekiq::(?:Worker|Job)|Shoryuken::Worker|Sneakers::Worker)\b|<\s*(?:ApplicationJob|ActiveJob::Base|Karafka::BaseConsumer|ApplicationConsumer)\b`,
            'sidekiq/activejob/karafka',
        ),
        entry(
            'rb.cli',
            String.raw`\bARGV\b|\bOptionParser\.new\b|<\s*Thor\b`,
            'cli',
        ),

        // Skipping the login filter opens the actions to anyone.
        entry(
            'rb.rails.skip-auth',
            String.raw`\bskip_before_action\s+:(?:authenticate\w*|require_\w+)`,
            'rails',
        ),
        auth(
            'rb.rails.auth',
            String.raw`\bbefore_action\s+:(?:authenticate\w*|require_\w+|authorize\w*|ensure_\w+|check_\w+|verify_\w+|logged_in\w*)|\bauthorize!?\s*\(?\s*[@:]?\w+|\bload_and_authorize_resource\b|\bverify_authorized\b|\bpolicy_scope\(|(?:^|[^:\w])authenticate_\w+!|\bhttp_basic_authenticate_with\b|\bauthenticate_or_request_with_http_\w+`,
            'rails/devise/pundit/cancancan',
        ),

        sink(
            'rb.sql.string-built',
            'injection',
            'CWE-89',
            any(sqlConcat(), sqlInString('"', INTERP)),
        ),
        sink(
            'rb.sql.activerecord',
            'injection',
            'CWE-89',
            String.raw`\.(?:where|order|reorder|group|having|joins|select|from|pluck|find_by_sql|exists\?|calculate|lock|update_all|delete_all|count_by_sql|execute|exec_query|select_all|select_value)\(\s*"[^"]*#\{|\.(?:order|reorder|group|pluck|select|from)\(\s*params\[|\bconnection\.(?:execute|exec_query|select_all|select_value)\(\s*[a-z_]\w*\s*\)`,
            'rails',
        ),
        sink(
            'rb.exec',
            'injection',
            'CWE-78',
            String.raw`\b(?:system|exec|spawn|IO\.popen|Open3\.(?:capture[23]e?|popen[23]e?|pipeline\w*))\(?\s*"[^"]*#\{|\x60[^\x60]*#\{|%x[(\[{][^)\]}]*#\{|\b(?:system|exec|IO\.popen)\(?\s*[a-z_@]\w*\s*\)?\s*$|(?:^|[^.\w])open\(\s*(?:params\[|"\|)`,
        ),
        sink(
            'rb.eval',
            'injection',
            'CWE-94',
            String.raw`(?:^|[^.\w])(?:eval|instance_eval|class_eval|module_eval)\(?\s*(?:params|[a-z_@]\w*\s*\)?\s*$|"[^"]*#\{)|\.(?:send|public_send|constantize|safe_constantize)\(\s*params\[|\bparams\[[^\]]*\]\.(?:constantize|safe_constantize)\b`,
        ),
        sink(
            'rb.deserialize',
            'injection',
            'CWE-502',
            String.raw`\bMarshal\.(?:load|restore)\(|\bYAML\.(?:unsafe_load|load)\(|\bOj\.load\([^)]*mode:\s*:object`,
        ),
        sink(
            'rb.template.injection',
            'injection',
            'CWE-1336',
            String.raw`\bERB\.new\(\s*(?:params|[a-z_@])|\brender\s*\(?\s*inline:\s*(?:params|[a-z_@]|"[^"]*#\{)|\bLiquid::Template\.parse\(\s*(?:params|[a-z_@])|\bHaml::(?:Engine|Template)\.new\(\s*(?:params|[a-z_@])`,
        ),
        sink(
            'rb.path.traversal',
            'injection',
            'CWE-22',
            String.raw`\b(?:File\.(?:read|open|write|delete|unlink|readlines|binread|new)|IO\.read|send_file|FileUtils\.\w+|Dir\.glob|Pathname\.new)\(?\s*(?:[^)]*params\[|"[^"]*#\{params)|\brender\s*\(?\s*(?:file:|template:|partial:)?\s*params\[`,
        ),
        sink(
            'rb.nosql.operator-injection',
            'injection',
            'CWE-943',
            String.raw`\.(?:where|any_of|find_by|or)\(\s*params(?:\[:\w+\]\s*\)|\.permit!|\.to_unsafe_h)`,
            'mongoid',
        ),
        sink(
            'rb.http.variable-url',
            'ssrf',
            'CWE-918',
            String.raw`\bNet::HTTP\.(?:get|get_response|post_form|start)\(\s*${VAR_ARG}|\bURI\.open\(\s*${VAR_ARG}|\b(?:HTTParty|Faraday|RestClient|Excon|HTTP|Typhoeus)\.(?:get|post|put|patch|delete|head|request)[(\s]\s*${VAR_ARG}|\bFaraday\.new\(\s*(?:url:\s*)?${VAR_ARG}|\bURI\.parse\(\s*params\[`,
        ),
        sink(
            'rb.activerecord.by-request-id',
            'authz',
            'CWE-639',
            // `Model.find(params[:id])` is unscoped; `current_user.invoices.find(...)` is not.
            String.raw`\b[A-Z]\w*\.(?:find|find_by|find_by!|find_by_id|where|destroy|delete|update)\(?\s*(?:id:\s*)?params\[:(?:id|\w+_id)\]`,
            'rails',
        ),
        sink(
            'rb.log.sensitive',
            'data_exposure',
            'CWE-532',
            logsSensitive(
                String.raw`\b(?:Rails\.logger|logger|@logger|Logger)\.(?:debug|info|warn|error|fatal)\b|\bputs\b`,
            ),
        ),
        sink(
            'rb.response.error-detail',
            'data_exposure',
            'CWE-209',
            String.raw`\brender\s*\(?\s*(?:json|plain|text|html):.*\b(?:e|ex|exception|error)\.(?:message|backtrace|full_message|inspect)\b|\bconsider_all_requests_local\s*=\s*true|\.backtrace\.join\b`,
        ),
        sink(
            'rb.response.whole-entity',
            'data_exposure',
            'CWE-200',
            String.raw`\brender\s*\(?\s*json:\s*@?(?:user|users|account|accounts|current_user)\s*\)?\s*$`,
        ),
        sink(
            'rb.crypto.weak-hash',
            'secret_identity',
            'CWE-328',
            String.raw`\bDigest::(?:MD5|SHA1)\b|\bOpenSSL::Digest(?:::|\.new\(\s*['"])(?:MD5|SHA1)`,
        ),
        sink(
            'rb.crypto.weak-cipher',
            'secret_identity',
            'CWE-327',
            String.raw`\bOpenSSL::Cipher\.new\(\s*['"](?:[Dd][Ee][Ss]|[Rr][Cc]4|[Bb][Ff]|[^'"]*-[Ee][Cc][Bb])`,
        ),
        sink(
            'rb.crypto.insecure-random',
            'secret_identity',
            'CWE-338',
            randomForSecret(
                String.raw`\brand\(|\bRandom\.(?:rand|new)\b|\.sample\b|\.shuffle\b`,
            ),
        ),
        timingCompare('rb'),
        sink(
            'rb.jwt.unverified',
            'secret_identity',
            'CWE-347',
            String.raw`\bJWT\.decode\(\s*\w+\s*,\s*(?:nil|[^,)]+,\s*false)`,
            'ruby-jwt',
        ),
        sink(
            'rb.tls.verification-disabled',
            'secret_identity',
            'CWE-295',
            String.raw`\bOpenSSL::SSL::VERIFY_NONE\b|\bssl:\s*\{\s*verify:\s*false`,
        ),
        ...commonSinks('rb', { nosql: true }),
    ],
};
