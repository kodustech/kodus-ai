#!/usr/bin/env python3
# Proxy local que grava o corpo das requisicoes do Claude Code e repassa para api.anthropic.com (streaming).
import http.server, http.client, json, os, time, ssl
OUT=os.path.expanduser('~/native/captura'); os.makedirs(OUT,exist_ok=True)
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n=int(self.headers.get('content-length',0)); body=self.rfile.read(n)
        if '/v1/messages' in self.path:
            try: open(f'{OUT}/req-{time.time():.3f}.json','wb').write(body)
            except Exception: pass
        c=http.client.HTTPSConnection('api.anthropic.com',context=ssl.create_default_context(),timeout=600)
        hs={k:v for k,v in self.headers.items() if k.lower() not in ('host','content-length','accept-encoding')}
        hs['Host']='api.anthropic.com'; hs['Content-Length']=str(len(body)); hs['Accept-Encoding']='identity'
        c.request('POST',self.path,body,hs); r=c.getresponse()
        self.send_response(r.status)
        for k,v in r.getheaders():
            if k.lower() not in ('transfer-encoding','content-length','connection','content-encoding'): self.send_header(k,v)
        self.send_header('Transfer-Encoding','chunked'); self.end_headers()
        while True:
            ch=r.read1(65536) if hasattr(r,'read1') else r.read(65536)
            if not ch: break
            self.wfile.write(b'%x\r\n'%len(ch)+ch+b'\r\n'); self.wfile.flush()
        self.wfile.write(b'0\r\n\r\n')
    def do_GET(self):
        self.send_response(404); self.end_headers()
    def log_message(self,*a): pass
http.server.ThreadingHTTPServer(('127.0.0.1',8765),H).serve_forever()
