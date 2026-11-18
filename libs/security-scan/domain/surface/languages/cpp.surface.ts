import { LanguageSurface } from '../surface.types';
import { cFamilyPatterns } from './c-family.shared';
import { auth, entry, sink, sqlConcat } from './shared';

export const CPP_SURFACE: LanguageSurface = {
    language: 'cpp',
    glob: '*.{cpp,cc,cxx,c++,hpp,hh,hxx,ipp}',
    patterns: [
        ...cFamilyPatterns('cpp'),
        entry(
            'cpp.http.route',
            String.raw`\bCROW_ROUTE\(|\b(?:ADD_METHOD_TO|PATH_ADD|METHOD_ADD|ADD_METHOD_VIA_REGEX)\(|\bRoutes::(?:Get|Post|Put|Delete|Patch)\(|\.(?:Get|Post|Put|Delete|Patch)\(\s*R?"/`,
            'crow/drogon/pistache/cpp-httplib',
        ),
        entry(
            'cpp.grpc.service',
            String.raw`\bgrpc::ServerContext\s*\*|::Service\s*\{`,
            'grpc',
        ),
        entry(
            'cpp.iostream.cin',
            String.raw`\bstd::cin\s*>>|\bstd::getline\(\s*std::cin`,
        ),
        auth(
            'cpp.http.auth',
            String.raw`\b(?:BasicAuth|BearerAuth|JwtAuth|AuthFilter|LoginFilter)\b|\bdrogon::HttpFilter<`,
            'drogon',
        ),
        sink('cpp.sql.concat', 'injection', 'CWE-89', sqlConcat()),
        sink(
            'cpp.http.variable-url-client',
            'ssrf',
            'CWE-918',
            String.raw`\bcpr::Url\s*\{\s*[a-z_]|\bhttplib::Client\s+\w+\(\s*[a-z_]`,
            'cpr/cpp-httplib',
        ),
    ],
};
