"""Mini web server for Mistcoast.  Usage:  python server/serve.py   ->  http://127.0.0.1:8765/

Serves the files in ../public, reachable from this machine only, and tells the browser not to cache
anything, so every change is picked up on the next reload.

Additionally: POST /api/general  {"system": "...", "prompt": "..."}  ->  {"ok": true, "text": "..."}
Lets a computer general answer through the Claude Code CLI (claude -p, model Sonnet).
The CLI runs without tools, without MCP servers, without session persistence, without your user settings
(output style, hooks, plugins) and in a fresh directory per call that is deleted afterwards:
a general can only return text; it cannot read, write or execute anything, and nothing outlives a call.
A general's memory is nothing but the game state in the browser – a new game starts empty.
"""
import functools
import http.server
import json
import os
import shutil
import subprocess
import tempfile

PORT = int(os.environ.get('MISTCOAST_PORT', '8765'))
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, 'public')
CLAUDE = shutil.which('claude')
MODELS = {'haiku', 'sonnet'}                 # allowed models
DEFAULT_MODEL = os.environ.get('MISTCOAST_MODEL', 'sonnet')   # for generals and the reporter (haiku = faster, cheaper)
if DEFAULT_MODEL not in MODELS:
    DEFAULT_MODEL = 'sonnet'
ORIGINS = {f'http://127.0.0.1:{PORT}', f'http://localhost:{PORT}'}
TIMEOUT = 150                                # seconds per general call
MAX_BODY = 200_000                           # bytes per request


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, max-age=0')
        super().end_headers()

    def log_message(self, *args):  # no output per request
        pass

    def reply(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/api/general':          # status check: is the CLI available?
            return self.reply(200, {'ok': bool(CLAUDE)})
        return super().do_GET()

    def do_POST(self):
        if self.path != '/api/general':
            return self.reply(404, {'ok': False, 'error': 'unknown path'})
        # Only our own page may consult the generals (other websites could otherwise burn your quota)
        origin = self.headers.get('Origin')
        if origin and origin not in ORIGINS:
            return self.reply(403, {'ok': False, 'error': 'foreign origin'})
        if 'application/json' not in self.headers.get('Content-Type', ''):
            return self.reply(415, {'ok': False, 'error': 'JSON expected'})
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > MAX_BODY:
            return self.reply(413, {'ok': False, 'error': 'request too large'})
        if not CLAUDE:
            return self.reply(503, {'ok': False, 'error': 'claude CLI not found'})
        try:
            data = json.loads(self.rfile.read(n).decode('utf-8'))
            model = data.get('model') if data.get('model') in MODELS else DEFAULT_MODEL
            cmd = [CLAUDE, '-p', '--model', model, '--tools', '', '--strict-mcp-config',
                   '--no-session-persistence', '--setting-sources', 'local',
                   '--exclude-dynamic-system-prompt-sections', '--system-prompt', str(data.get('system', ''))]
            # every call runs in its own empty directory that is deleted afterwards: no CLAUDE.md, no leftovers
            with tempfile.TemporaryDirectory(prefix='mistcoast-general-') as work:
                r = subprocess.run(cmd, input=str(data.get('prompt', '')), capture_output=True, text=True,
                                   encoding='utf-8', errors='replace', timeout=TIMEOUT, cwd=work)
            if r.returncode != 0:
                return self.reply(502, {'ok': False, 'error': (r.stderr or r.stdout)[-500:]})
            return self.reply(200, {'ok': True, 'text': r.stdout})
        except subprocess.TimeoutExpired:
            return self.reply(504, {'ok': False, 'error': 'timeout'})
        except Exception as e:  # noqa: BLE001 – report errors to the page instead of crashing the server
            return self.reply(500, {'ok': False, 'error': str(e)[:300]})


def main():
    handler = functools.partial(Handler, directory=os.path.normpath(ROOT))
    with http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler) as httpd:
        print(f'Mistcoast is running at http://127.0.0.1:{PORT}/  (Ctrl+C to stop)')
        print('Generals (Claude CLI):', CLAUDE or 'not found')
        httpd.serve_forever()


if __name__ == '__main__':
    main()
