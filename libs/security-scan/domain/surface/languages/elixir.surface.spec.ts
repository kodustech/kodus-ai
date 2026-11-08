import { describeSurfaceCases } from '../testing/surface-cases';
import { ELIXIR_SURFACE } from './elixir.surface';

describeSurfaceCases(
    ELIXIR_SURFACE,
    'lib/app_web/controllers/invoice_controller.ex',
    [
        // entry points
        {
            role: 'entry_point',
            match: true,
            patternId: 'ex.phoenix.route',
            file: 'lib/app_web/router.ex',
            code: '    get "/invoices/:id", InvoiceController, :show',
        },
        {
            role: 'entry_point',
            match: true,
            patternId: 'ex.phoenix.route',
            file: 'lib/app_web/router.ex',
            code: '  scope "/api", AppWeb do',
        },
        {
            role: 'entry_point',
            match: true,
            patternId: 'ex.phoenix.action',
            code: '  def show(conn, %{"id" => id}) do',
        },
        {
            role: 'entry_point',
            match: true,
            patternId: 'ex.phoenix.live-channel',
            code: '  def handle_event("save", params, socket) do',
        },
        {
            role: 'entry_point',
            match: true,
            patternId: 'ex.consumer',
            code: '  use Oban.Worker, queue: :mailers',
        },
        {
            role: 'entry_point',
            match: true,
            patternId: 'ex.cli',
            code: '    {opts, _, _} = OptionParser.parse(args, switches: [path: :string])',
        },
        {
            role: 'entry_point',
            match: false,
            code: '  defp helper(x), do: x + 1',
        },

        // auth checks
        {
            role: 'auth_check',
            match: true,
            patternId: 'ex.auth',
            file: 'lib/app_web/router.ex',
            code: '    pipe_through [:browser, :require_authenticated_user]',
        },
        {
            role: 'auth_check',
            match: true,
            patternId: 'ex.auth',
            code: '  plug Guardian.Plug.EnsureAuthenticated',
        },

        // injection
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'ex.sql.string-built',
            code: '    Repo.query("SELECT * FROM users WHERE name = \'#{name}\'")',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'ex.sql.raw-call',
            code: '    from(u in User, where: fragment("lower(#{field}) = ?", ^value))',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: false,
            code: '    Repo.query("SELECT * FROM users WHERE id = $1", [id])',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'ex.exec',
            code: '    System.shell("convert #{path} out.png")',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'ex.exec',
            code: '    System.cmd("sh", ["-c", cmd])',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: false,
            code: '    System.cmd("git", ["clone", "--", repo_url])',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'ex.eval',
            code: '    {result, _} = Code.eval_string(params["expr"])',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'ex.template.injection',
            code: '    EEx.eval_string(template, assigns: assigns)',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'ex.deserialize',
            code: '    term = :erlang.binary_to_term(body)',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'ex.path.traversal',
            code: '    send_file(conn, 200, Path.join(@uploads, params["name"]))',
        },

        // ssrf
        {
            role: 'sink',
            vulnClass: 'ssrf',
            match: true,
            patternId: 'ex.http.variable-url',
            code: '    {:ok, resp} = HTTPoison.get(url)',
        },
        {
            role: 'sink',
            vulnClass: 'ssrf',
            match: true,
            patternId: 'ex.http.variable-url',
            code: '    Req.get!("https://#{host}/status")',
        },
        {
            role: 'sink',
            vulnClass: 'ssrf',
            match: false,
            code: '    {:ok, resp} = HTTPoison.get("https://api.example.com/health")',
        },

        // authz
        {
            role: 'sink',
            vulnClass: 'authz',
            match: true,
            patternId: 'ex.repo.by-id-only',
            code: '    invoice = Repo.get!(Invoice, id)',
        },
        {
            role: 'sink',
            vulnClass: 'authz',
            match: true,
            patternId: 'ex.repo.by-id-only',
            code: '    post = Blog.get_post!(id)',
        },
        {
            role: 'sink',
            vulnClass: 'authz',
            match: false,
            code: '    invoice = Repo.get_by!(Invoice, id: id, user_id: user.id)',
        },

        // data exposure
        {
            role: 'sink',
            vulnClass: 'data_exposure',
            match: true,
            patternId: 'ex.log.sensitive',
            code: '    Logger.info("login #{email} password=#{password}")',
        },
        {
            role: 'sink',
            vulnClass: 'data_exposure',
            match: true,
            patternId: 'ex.response.error-detail',
            file: 'config/dev.exs',
            code: '  debug_errors: true,',
        },
        {
            role: 'sink',
            vulnClass: 'data_exposure',
            match: true,
            patternId: 'ex.response.whole-entity',
            code: '  @derive Jason.Encoder',
        },
        {
            role: 'sink',
            vulnClass: 'data_exposure',
            match: false,
            code: '  @derive {Jason.Encoder, only: [:id, :name]}',
        },

        // secret / identity
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: true,
            patternId: 'ex.common.hardcoded-secret',
            file: 'config/prod.exs',
            code: '  secret_key_base: "Zx9yW8vU7tS6rQ5pO4nM",',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: true,
            patternId: 'ex.crypto.weak-hash',
            code: '    :crypto.hash(:md5, password)',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: true,
            patternId: 'ex.crypto.weak-cipher',
            code: '    :crypto.crypto_one_time(:aes_128_ecb, key, data, true)',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: true,
            patternId: 'ex.crypto.insecure-random',
            code: '    otp = :rand.uniform(999_999)',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: true,
            patternId: 'ex.crypto.timing-unsafe-compare',
            code: '    if provided == expected_signature, do: :ok, else: :error',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: true,
            patternId: 'ex.jwt.unverified',
            code: '    {:ok, claims} = Joken.peek_claims(token)',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: true,
            patternId: 'ex.tls.verification-disabled',
            code: '    ssl: [verify: :verify_none]',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: false,
            code: '    if Plug.Crypto.secure_compare(provided, expected), do: :ok',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: false,
            code: '    secret_key_base: System.fetch_env!("SECRET_KEY_BASE"),',
        },
    ],
);
