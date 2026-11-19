import { describeSurfaceCases } from '../testing/surface-cases';
import { RUST_SURFACE } from './rust.surface';

describeSurfaceCases(RUST_SURFACE, 'src/handlers.rs', [
    // entry points
    {
        role: 'entry_point',
        match: true,
        patternId: 'rs.attr.route',
        code: '#[get("/users/{id}")]\nasync fn get_user(path: web::Path<u32>) -> impl Responder {',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'rs.router.route',
        code: '        .route("/users/:id", get(get_user))',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'rs.handler.extractor',
        code: 'async fn create(Json(payload): Json<CreateUser>) -> impl IntoResponse {',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'rs.grpc.service',
        code: '#[tonic::async_trait]',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'rs.cli.args',
        code: '    let args: Vec<String> = env::args().collect();',
    },
    {
        role: 'entry_point',
        match: false,
        code: 'fn helper(x: u32) -> u32 { x + 1 }',
    },

    // auth checks
    {
        role: 'auth_check',
        match: true,
        patternId: 'rs.auth',
        code: '        .wrap(HttpAuthentication::bearer(validator))',
    },
    {
        role: 'auth_check',
        match: true,
        patternId: 'rs.auth',
        code: '        .layer(middleware::from_fn(require_auth))',
    },

    // injection
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'rs.sql.string-built',
        code: '    let q = format!("SELECT * FROM users WHERE name = \'{}\'", name);',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'rs.sql.raw-call',
        code: '    let rows = sqlx::query(&sql).fetch_all(&pool).await?;',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: false,
        code: '    let row = sqlx::query("SELECT * FROM users WHERE id = $1").bind(id).fetch_one(&pool).await?;',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'rs.exec.command',
        code: '    let out = Command::new("sh").arg("-c").arg(&cmd).output()?;',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'rs.exec.command',
        code: '    let out = Command::new(program).args(&args).output()?;',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: false,
        code: '    let out = Command::new("git").args(["clone", "--", &url]).output()?;',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'rs.template.injection',
        code: '    let html = Tera::one_off(&user_template, &ctx, true)?;',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'rs.path.traversal',
        code: '    let body = fs::read_to_string(base.join(&params.name))?;',
    },

    // ssrf
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: true,
        patternId: 'rs.http.variable-url',
        code: '    let body = reqwest::get(&target).await?.text().await?;',
    },
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: true,
        patternId: 'rs.http.variable-url',
        code: '    let resp = client.get(url).send().await?;',
    },
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: false,
        code: '    let resp = client.get("https://api.example.com/health").send().await?;',
    },

    // authz
    {
        role: 'sink',
        vulnClass: 'authz',
        match: true,
        patternId: 'rs.orm.by-id-only',
        code: '    let inv = invoices::table.find(invoice_id).first::<Invoice>(&mut conn)?;',
    },
    {
        role: 'sink',
        vulnClass: 'authz',
        match: true,
        patternId: 'rs.common.sql-by-id-only',
        code: '    sqlx::query_as::<_, Invoice>("SELECT * FROM invoices WHERE id = $1")',
    },
    {
        role: 'sink',
        vulnClass: 'authz',
        match: false,
        code: '    invoices::table.filter(id.eq(invoice_id).and(owner_id.eq(user.id))).first::<Invoice>(&mut conn)?;',
    },

    // data exposure
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: true,
        patternId: 'rs.log.sensitive',
        code: '    info!("login user={} password={}", user, password);',
    },
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: true,
        patternId: 'rs.response.error-detail',
        code: '        Err(e) => HttpResponse::InternalServerError().body(e.to_string()),',
    },
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: true,
        patternId: 'rs.response.whole-entity',
        code: '    HttpResponse::Ok().json(user)',
    },
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: false,
        code: '    info!("login ok user_id={}", user.id);',
    },

    // secret / identity
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'rs.common.hardcoded-secret',
        code: 'const JWT_SECRET: &str = "s3cr3t-signing-key";',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'rs.crypto.weak-hash',
        code: '    let digest = md5::compute(password.as_bytes());',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'rs.crypto.weak-cipher',
        code: '    let enc = ecb::Encryptor::<Aes128>::new(&key.into());',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'rs.crypto.insecure-random',
        code: '    let token: u64 = fastrand::u64(..);',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'rs.crypto.timing-unsafe-compare',
        code: '    if provided == expected_token { return Ok(()); }',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'rs.jwt.unverified',
        code: '    validation.insecure_disable_signature_validation();',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'rs.tls.verification-disabled',
        code: '    let client = Client::builder().danger_accept_invalid_certs(true).build()?;',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: false,
        code: '    if provided.ct_eq(&expected).into() { return Ok(()); }',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: false,
        code: '    let secret = std::env::var("JWT_SECRET")?;',
    },
]);
