// Terminal for omarchyd: your login shell (or a shell inside an app's container) in a real pseudo-
// terminal, over a WebSocket. The pty comes from util-linux `script`, which every Arch system has,
// so there is no native module to build. Size is set once when the shell starts (the web app keeps
// the column count and scales its font instead). Runs as you, like the rest of omarchyd.
import {spawn} from 'node:child_process'
import os from 'node:os'

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

// Start a shell in a pty. `command` is an argv run instead of the login shell (for app shells).
export function openShell({cols, rows, command = null, cwd = os.homedir(), env = process.env, home = os.homedir()}) {
	const shell = env.SHELL && /^\/[\w/.-]+$/.test(env.SHELL) ? env.SHELL : '/bin/bash'
	const inner = command ? command.map(quote).join(' ') : `${quote(shell)} -l`
	return spawn('script', ['-q', '-f', '-e', '-c', `stty cols ${cols} rows ${rows} 2>/dev/null; exec ${inner}`, '/dev/null'], {
		cwd,
		env: {...env, HOME: home, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: env.LANG || 'C.UTF-8'},
	})
}

// Wire a WebSocket to a shell: text in, terminal bytes out; closing either side ends both.
export function bridge(ws, child) {
	child.stdout.on('data', (d) => ws.readyState === ws.OPEN && ws.send(d, {binary: true}))
	child.stderr.on('data', (d) => ws.readyState === ws.OPEN && ws.send(d, {binary: true}))
	ws.on('message', (d) => child.stdin.writable && child.stdin.write(d))
	child.on('exit', () => ws.readyState === ws.OPEN && ws.close(1000, 'Shell ended'))
	child.on('error', () => ws.readyState === ws.OPEN && ws.close(1011, 'Couldn’t start a shell'))
	const end = () => {
		if (child.exitCode === null) child.kill('SIGHUP')
	}
	ws.on('close', end)
	ws.on('error', end)
}
