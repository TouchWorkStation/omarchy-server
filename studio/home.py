#!/usr/bin/env python3
"""A short page for SolverForge Studio. The work happens in the terminal."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PAGE = """<!doctype html>
<meta charset="utf-8">
<title>SolverForge Studio</title>
<style>
  body { font: 16px/1.5 sans-serif; max-width: 42rem; margin: 3rem auto; padding: 0 1rem; }
  code, pre { font: 14px/1.45 ui-monospace, monospace; }
  pre { background: #f4f4f4; padding: 1rem; overflow: auto; }
</style>
<h1>SolverForge Studio</h1>
<p>This app builds a planning program. Open its terminal in Omarchy Server. Projects live in <code>/work</code>, which is your Documents folder.</p>
<pre>cd /work
solverforge new my-scheduler
cd my-scheduler
# shape the model, then:
cargo build --release
omarchy-publish publish --id my-scheduler --name "My scheduler" \\
  --binary /work/my-scheduler/target/release/my-scheduler \\
  --assets /work/my-scheduler/static</pre>
<p>The published app’s web page stays behind sign-in. Its job API is a separate port on this network and asks for the token shown on that app’s page.</p>
""".encode()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = PAGE
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        return


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
