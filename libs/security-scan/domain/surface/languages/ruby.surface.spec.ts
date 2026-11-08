import { describeSurfaceCases } from '../testing/surface-cases';
import { RUBY_SURFACE } from './ruby.surface';

describeSurfaceCases(RUBY_SURFACE, 'app/controllers/invoices_controller.rb', [
    // entry points
    {
        role: 'entry_point',
        match: true,
        patternId: 'rb.rails.routes',
        file: 'config/routes.rb',
        code: '  resources :invoices, only: [:show, :update]',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'rb.rails.routes',
        file: 'config/routes.rb',
        code: "  get 'reports/:id', to: 'reports#show'",
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'rb.rails.controller',
        code: 'class InvoicesController < ApplicationController',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'rb.sinatra.route',
        file: 'app.rb',
        code: "get '/hello/:name' do",
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'rb.graphql',
        code: 'class Mutations::CreatePost < Mutations::BaseMutation',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'rb.job.consumer',
        code: '  include Sidekiq::Job',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'rb.cli',
        code: 'path = ARGV.first',
    },
    { role: 'entry_point', match: false, code: '  def helper(x) = x + 1' },

    // auth checks
    {
        role: 'auth_check',
        match: true,
        patternId: 'rb.rails.auth',
        code: '  before_action :authenticate_user!',
    },
    {
        role: 'auth_check',
        match: true,
        patternId: 'rb.rails.auth',
        code: '    authorize @invoice',
    },

    // injection
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'rb.sql.string-built',
        code: '    ActiveRecord::Base.connection.execute("SELECT * FROM users WHERE name = \'#{params[:name]}\'")',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'rb.sql.activerecord',
        code: '    User.where("name = \'#{params[:name]}\'")',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'rb.sql.activerecord',
        code: '    @users = User.order(params[:sort])',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: false,
        code: '    User.where("name = ?", params[:name])',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: false,
        code: '    User.where(name: params[:name])',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'rb.exec',
        code: '    system("convert #{params[:file]} out.png")',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'rb.exec',
        code: '    output = `git log #{branch}`',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: false,
        code: '    system("git", "clone", "--", repo_url)',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'rb.eval',
        code: '    klass = params[:type].constantize',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'rb.deserialize',
        code: '    obj = Marshal.load(Base64.decode64(cookies[:state]))',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'rb.template.injection',
        code: '    render inline: params[:template]',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'rb.path.traversal',
        code: '    send_file Rails.root.join("uploads", params[:name])',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'rb.nosql.operator-injection',
        code: '    User.where(params[:filter])',
    },

    // ssrf
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: true,
        patternId: 'rb.http.variable-url',
        code: '    response = HTTParty.get(params[:url])',
    },
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: true,
        patternId: 'rb.http.variable-url',
        code: '    body = Net::HTTP.get(URI(callback_url))',
    },
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: false,
        code: '    response = HTTParty.get("https://api.example.com/health")',
    },

    // authz
    {
        role: 'sink',
        vulnClass: 'authz',
        match: true,
        patternId: 'rb.activerecord.by-request-id',
        code: '    @invoice = Invoice.find(params[:id])',
    },
    {
        role: 'sink',
        vulnClass: 'authz',
        match: false,
        code: '    @invoice = current_user.invoices.find(params[:id])',
    },

    // data exposure
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: true,
        patternId: 'rb.log.sensitive',
        code: '    Rails.logger.info("login #{email} password=#{password}")',
    },
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: true,
        patternId: 'rb.response.error-detail',
        code: '    render json: { error: e.message, trace: e.backtrace }, status: 500',
    },
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: true,
        patternId: 'rb.response.whole-entity',
        code: '    render json: @user',
    },
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: false,
        code: '    render json: @user, only: [:id, :name]',
    },

    // secret / identity
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'rb.common.hardcoded-secret',
        code: '  API_KEY = "rk_live_abcdef123456"',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'rb.crypto.weak-hash',
        code: '    digest = Digest::MD5.hexdigest(password)',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'rb.crypto.weak-cipher',
        code: "    cipher = OpenSSL::Cipher.new('aes-128-ecb')",
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'rb.crypto.insecure-random',
        code: '    token = (0...32).map { CHARS.sample }.join',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'rb.crypto.timing-unsafe-compare',
        code: '    head :unauthorized unless request.headers["X-Token"] == expected_token',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'rb.jwt.unverified',
        code: '    payload, = JWT.decode(token, nil, false)',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'rb.tls.verification-disabled',
        code: '    http.verify_mode = OpenSSL::SSL::VERIFY_NONE',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: false,
        code: '    token = SecureRandom.hex(32)',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: false,
        code: '    ActiveSupport::SecurityUtils.secure_compare(a, b)',
    },
]);
