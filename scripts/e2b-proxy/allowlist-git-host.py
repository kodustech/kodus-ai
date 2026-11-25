"""Throwaway smart-HTTP git server for egress-route-probe.ts.

Serves the bare repositories under ./egress-probe-repos (acme.git and
open.git, each with a `feature` branch). acme.git answers only the fixed
egress IP; any other caller gets the 403 GitHub sends when an IP allow list
refuses it. open.git answers everyone. Every request is logged to
egress-probe-git.log with the caller IP the tunnel reported (the right-most X-Forwarded-For).

    python3 allowlist-git-host.py 8099
"""
import http.server, os, subprocess, sys, json, time

ROOT = os.path.abspath('egress-probe-repos')
ALLOWED = {'52.55.217.197'}
LOG = os.path.abspath('egress-probe-git.log')

class H(http.server.BaseHTTPRequestHandler):
    def _client(self):
        # The tunnel appends the address it saw, so the right-most entry is
        # the only one a caller cannot write; anything left of it is theirs.
        xff = self.headers.get('X-Forwarded-For', '')
        return xff.split(',')[-1].strip() or self.client_address[0]

    def _reply(self, status, body):
        self.send_response(status)
        self.send_header('Content-Type', 'text/plain')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle(self):
        ip = self._client()
        allowed = ip in ALLOWED or self.path.startswith('/open.git')
        with open(LOG, 'a') as f:
            f.write(json.dumps({'t': time.strftime('%H:%M:%S'), 'ip': ip, 'allowed': allowed, 'method': self.command, 'path': self.path}) + '\n')
        if not allowed:
            body = (f"the `acme` organization has an IP allow list enabled, and your IP address is not permitted to access this resource.\n").encode()
            self._reply(403, body)
            return
        path, _, query = self.path.partition('?')
        raw_length = self.headers.get('Content-Length') or '0'
        if not raw_length.isdigit():
            self._reply(400, b'Content-Length must be a non-negative integer\n')
            return
        length = int(raw_length)
        data = self.rfile.read(length) if length else b''
        env = dict(os.environ, GIT_PROJECT_ROOT=ROOT, GIT_HTTP_EXPORT_ALL='1', PATH_INFO=path,
                   QUERY_STRING=query, REQUEST_METHOD=self.command, REMOTE_ADDR=ip,
                   CONTENT_TYPE=self.headers.get('Content-Type', ''), CONTENT_LENGTH=str(len(data)))
        if self.headers.get('Git-Protocol'):
            env['GIT_PROTOCOL'] = self.headers['Git-Protocol']
        out = subprocess.run(['git', 'http-backend'], input=data, env=env, capture_output=True).stdout
        head, _, body = out.partition(b'\r\n\r\n')
        status = 200
        headers = []
        for line in head.decode().split('\r\n'):
            if not line: continue
            k, _, v = line.partition(':')
            if k.lower() == 'status': status = int(v.strip().split()[0])
            else: headers.append((k, v.strip()))
        self.send_response(status)
        for k, v in headers: self.send_header(k, v)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = _handle
    do_POST = _handle
    def log_message(self, *a): pass

def seed():
    """Creates the two bare repositories once."""
    if os.path.isdir(os.path.join(ROOT, 'acme.git')):
        return
    work = os.path.join(ROOT, '_work')
    env = dict(os.environ, GIT_AUTHOR_NAME='probe', GIT_AUTHOR_EMAIL='probe@example.invalid',
               GIT_COMMITTER_NAME='probe', GIT_COMMITTER_EMAIL='probe@example.invalid')
    for cmd in (['git', 'init', '-q', '-b', 'main', work],):
        subprocess.run(cmd, check=True)
    open(os.path.join(work, 'README.md'), 'w').write('hello\n')
    for cmd in (['git', 'add', '.'], ['git', 'commit', '-qm', 'init'], ['git', 'checkout', '-qb', 'feature']):
        subprocess.run(cmd, cwd=work, env=env, check=True)
    for name in ('acme.git', 'open.git'):
        subprocess.run(['git', 'clone', '-q', '--bare', work, os.path.join(ROOT, name)], check=True)


seed()
http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
