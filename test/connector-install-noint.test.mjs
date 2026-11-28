// connector/install.sh --user-enroll-only and noninteractive sudo, in a temporary home with
// stand-ins for sudo, systemctl, curl and python3. A sudo that needs a terminal must not hang.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile, access, stat} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {after, test} from 'node:test'
import {fileURLToPath} from 'node:url'

const SCRIPT = fileURLToPath(new URL('../connector/install.sh', import.meta.url))
const AGENT = fileURLToPath(new URL('../connector/agent.py', import.meta.url))
const skip = process.platform !== 'linux' ? 'needs Linux and bash' : false
const root = await mkdtemp(join(os.tmpdir(), 'connector-noint-'))
after(() => rm(root, {recursive: true, force: true}))

const PEM = `-----BEGIN CERTIFICATE-----\n${Buffer.from('not really a certificate, just bytes').toString('base64')}\n-----END CERTIFICATE-----\n`
const CA = createHash('sha256').update(Buffer.from('not really a certificate, just bytes')).digest('hex')
const ARGS = ['--server', 'https://192.168.1.20:7780', '--ca', CA, '--token', 'abc123', '--allow', 'terminal,desktop,manage,storage,files']

async function stubs({python3 = true} = {}) {
	const bin = join(root, `bin-${Math.random().toString(16).slice(2)}`)
	await mkdir(bin)
	const put = async (name, body) => (await writeFile(join(bin, name), `#!/bin/bash\n${body}\n`), chmod(join(bin, name), 0o755))
	await put('uname', 'exec /usr/bin/uname "$@"')
	await put('id', 'exec /usr/bin/id "$@"')
	await put(
		'sudo',
		`echo "sudo $*" >>"$FAKE_LOG"
if [ -n "$FAKE_SUDO_FAILS" ]; then
	echo "sudo: a terminal is required to read the password" >&2
	exit 1
fi
exit 0`,
	)
	await put('systemctl', 'echo "systemctl $*" >>"$FAKE_LOG"; exit 0')
	await put('apt-get', 'echo "apt-get $*" >>"$FAKE_LOG"; exit 0')
	await put(
		'curl',
		`out=""; prev=""; for a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; done
echo "curl $*" >>"$FAKE_LOG"
case "$*" in
	*ca.crt*) printf '%s' "$FAKE_PEM" >"$out" ;;
	*lxc-helper.py*) cp "$FAKE_LXC_HELPER" "$out" ;;
	*vm-helper.py*) cp "$FAKE_VM_HELPER" "$out" ;;
	*agent.py*) cp "$FAKE_AGENT" "$out" ;;
esac`,
	)
	if (python3) {
		await put(
			'python3',
			`if [ "$2" = enroll ]; then echo "enroll $*" >>"$FAKE_LOG"; echo "Guest box"; exit 0; fi
exec /usr/bin/python3 "$@"`,
		)
	}
	return bin
}

function install(home, bin, args, extra = {}) {
	const log = join(home, 'log')
	const r = spawnSync('/usr/bin/bash', [SCRIPT, ...args], {
		env: {
			HOME: home,
			PATH: extra.path ?? `${bin}:/usr/bin:/bin`,
			USER: extra.USER ?? 'chris',
			FAKE_LOG: log,
			FAKE_PEM: PEM,
			FAKE_AGENT: AGENT,
			FAKE_VM_HELPER: fileURLToPath(new URL('../connector/vm-helper.py', import.meta.url)),
			FAKE_LXC_HELPER: fileURLToPath(new URL('../connector/lxc-helper.py', import.meta.url)),
			FAKE_SUDO_FAILS: extra.FAKE_SUDO_FAILS,
			OMARCHY_CONNECTOR_NONINTERACTIVE: extra.OMARCHY_CONNECTOR_NONINTERACTIVE,
			FAKE_UNIT: extra.FAKE_UNIT,
		},
		encoding: 'utf8',
		timeout: 20000,
	})
	return {status: r.status, out: `${r.stdout}${r.stderr}`, log, error: r.error}
}

test('--user-enroll-only enrolls without sudo and enables the user unit', {skip}, async () => {
	const home = join(root, 'enroll-only')
	await mkdir(home)
	const r = install(home, await stubs(), [...ARGS, '--user-enroll-only'])
	assert.equal(r.status, 0, r.out)
	assert.equal(r.error, undefined)
	const log = await readFile(r.log, 'utf8')
	assert.equal(/sudo/.test(log), false, log)
	assert.match(log, /systemctl --user enable --now omarchy-connector\.service/)
	assert.match(log, /enroll https:\/\/192\.168\.1\.20:7780 abc123 terminal,desktop,manage,storage,files$/m)
	const unit = await readFile(join(home, '.config/systemd/user/omarchy-connector.service'), 'utf8')
	assert.match(unit, /ExecStart=\/usr\/bin\/env python3 .*\/omarchy-connector\/agent\.py/)
	await access(join(home, '.config/omarchy-connector/server-ca.crt'))
	assert.match(r.out, /Guest box" is now in your server/)
})

test('noninteractive sudo that needs a terminal exits 4 instead of hanging', {skip}, async () => {
	const home = join(root, 'need-sudo')
	await mkdir(home)
	const r = install(home, await stubs(), ['--server', 'https://192.168.1.20:7780', '--ca', CA, '--token', 'abc123', '--allow', 'terminal,desktop,manage,files'], {
		FAKE_SUDO_FAILS: '1',
		OMARCHY_CONNECTOR_NONINTERACTIVE: '1',
	})
	assert.equal(r.error, undefined, r.out)
	assert.equal(r.status, 4, r.out)
	const log = await readFile(r.log, 'utf8')
	assert.match(log, /sudo -n /)
	assert.doesNotMatch(log, /enroll /, log)
	assert.doesNotMatch(r.out, /Done\./)
	assert.match(r.out, /password to finish installing|administrator permission/i)
	assert.doesNotMatch(r.out, /secret-pw|hunter2/)
})

test('noninteractive linger sudo -n failure before enroll exits 4 with no enroll line', {skip}, async () => {
	const home = join(root, 'linger-before')
	await mkdir(home)
	const bin = await stubs()
	const put = async (name, body) => (await writeFile(join(bin, name), `#!/bin/bash\n${body}\n`), chmod(join(bin, name), 0o755))
	await put(
		'sudo',
		`echo "sudo $*" >>"$FAKE_LOG"
case "$*" in
	*loginctl*) echo "sudo: a terminal is required to read the password" >&2; exit 1 ;;
esac
exit 0`,
	)
	await put('loginctl', 'echo Linger=no')
	const r = install(home, bin, ['--server', 'https://192.168.1.20:7780', '--ca', CA, '--token', 'abc123', '--allow', 'terminal,desktop,manage,files'], {OMARCHY_CONNECTOR_NONINTERACTIVE: '1'})
	assert.equal(r.error, undefined, r.out)
	assert.equal(r.status, 4, r.out)
	const log = await readFile(r.log, 'utf8')
	assert.match(log, /sudo -n loginctl enable-linger /)
	assert.doesNotMatch(log, /enroll /, log)
	assert.doesNotMatch(r.out, /Done\./)
})

test('a failed package install warns and still enrolls', {skip}, async () => {
	const home = join(root, 'pkg-warn')
	await mkdir(home)
	const bin = await stubs()
	const put = async (name, body) => (await writeFile(join(bin, name), `#!/bin/bash\n${body}\n`), chmod(join(bin, name), 0o755))
	await put(
		'sudo',
		`echo "sudo $*" >>"$FAKE_LOG"
case "$*" in
	*apt-get*) echo "E: Unable to locate package" >&2; exit 100 ;;
esac
exit 0`,
	)
	await put('loginctl', 'echo Linger=yes')
	for (const name of ['mktemp', 'mkdir', 'chmod', 'install', 'mv', 'rm', 'cat', 'grep', 'cp']) {
		await put(name, `exec /usr/bin/${name} "$@"`)
	}
	const r = install(
		home,
		bin,
		['--server', 'https://192.168.1.20:7780', '--ca', CA, '--token', 'abc123', '--allow', 'terminal,desktop,manage,files'],
		{path: bin, OMARCHY_CONNECTOR_NONINTERACTIVE: '1'},
	)
	assert.equal(r.error, undefined, r.out)
	assert.equal(r.status, 0, r.out)
	assert.match(r.out, /Couldn't install/)
	assert.doesNotMatch(r.out, /password to finish installing/)
	const log = await readFile(r.log, 'utf8')
	assert.match(log, /sudo -n /)
	assert.match(log, /enroll https:\/\/192\.168\.1\.20:7780 abc123 terminal,desktop,manage,files$/m)
	assert.match(log, /systemctl --user enable --now omarchy-connector\.service/)
})

test('--allow vms installs the helper as the user and qemu packages, and keeps NoNewPrivileges when storage is off', {skip}, async () => {
	const home = join(root, 'vms-allow')
	await mkdir(home)
	const bin = await stubs()
	const arch = spawnSync('uname', ['-m'], {encoding: 'utf8'}).stdout.trim()
	const qemuPkg = arch === 'aarch64' || arch === 'arm64' ? 'qemu-system-arm' : 'qemu-system-x86'
	const r = install(home, bin, ['--server', 'https://192.168.1.20:7780', '--ca', CA, '--token', 'abc123', '--allow', 'terminal,vms'])
	assert.equal(r.status, 0, r.out)
	const log = await readFile(r.log, 'utf8')
	assert.match(log, new RegExp(`apt-get install -y ${qemuPkg}`))
	assert.match(log, /apt-get install -y passt/)
	assert.match(log, /apt-get install -y xorriso/)
	const helper = join(home, '.local/share/omarchy-connector/vm-helper.py')
	const st = await stat(helper)
	assert.equal(st.mode & 0o777, 0o700)
	assert.equal(/libexec\/omarchy-connector\/vm-helper/.test(log), false)
	const unit = await readFile(join(home, '.config/systemd/user/omarchy-connector.service'), 'utf8')
	assert.match(unit, /NoNewPrivileges=yes/)
})

test('--allow terminal does not install qemu', {skip}, async () => {
	const home = join(root, 'no-vms')
	await mkdir(home)
	const r = install(home, await stubs(), ['--server', 'https://192.168.1.20:7780', '--ca', CA, '--token', 'abc123', '--allow', 'terminal'])
	assert.equal(r.status, 0, r.out)
	const log = await readFile(r.log, 'utf8')
	assert.equal(/qemu-base|qemu-system|libvirt/.test(log), false)
	await assert.rejects(stat(join(home, '.local/share/omarchy-connector/vm-helper.py')))
})

test('--user-enroll-only with no python3 exits 1, not 4', {skip}, async () => {
	const home = join(root, 'no-python')
	await mkdir(home)
	const bin = await stubs({python3: false})
	const r = install(home, bin, [...ARGS, '--user-enroll-only'], {path: bin, FAKE_SUDO_FAILS: '1'})
	assert.equal(r.status, 1, r.out)
	assert.match(r.out, /Python 3 is needed/)
	assert.doesNotMatch(r.out, /Done\./)
	try {
		const log = await readFile(r.log, 'utf8')
		assert.doesNotMatch(log, /sudo/)
	} catch (error) {
		if (error.code !== 'ENOENT') throw error
	}
})

async function openrcBin() {
	const bin = join(root, `openrc-bin-${Math.random().toString(16).slice(2)}`)
	await mkdir(bin)
	const put = async (name, body) => (await writeFile(join(bin, name), `#!/bin/bash\n${body}\n`), chmod(join(bin, name), 0o755))
	await put('uname', 'exec /usr/bin/uname "$@"')
	await put('id', 'exec /usr/bin/id "$@"')
	await put(
		'sudo',
		`echo "sudo $*" >>"$FAKE_LOG"
if [ -n "$FAKE_SUDO_FAILS" ]; then
	echo "sudo: a terminal is required to read the password" >&2
	exit 1
fi
case "$*" in
	*tee*) cat >"$FAKE_UNIT" ;;
esac
exit 0`,
	)
	await put('apk', 'echo "apk $*" >>"$FAKE_LOG"; exit 0')
	await put('rc-service', 'echo "rc-service $*" >>"$FAKE_LOG"; exit 0')
	await put('rc-update', 'echo "rc-update $*" >>"$FAKE_LOG"; exit 0')
	await put(
		'curl',
		`out=""; prev=""; for a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; done
echo "curl $*" >>"$FAKE_LOG"
case "$*" in *ca.crt*) printf '%s' "$FAKE_PEM" >"$out" ;; *agent.py*) cp "$FAKE_AGENT" "$out" ;; esac`,
	)
	await put(
		'python3',
		`if [ "$2" = enroll ]; then echo "enroll $*" >>"$FAKE_LOG"; echo "Alpine box"; exit 0; fi
exec /usr/bin/python3 "$@"`,
	)
	for (const name of ['mktemp', 'mkdir', 'chmod', 'install', 'mv', 'rm', 'cat', 'grep', 'cp', 'tee', 'touch']) {
		await put(name, `exec /usr/bin/${name} "$@"`)
	}
	return bin
}

test('OpenRC install uses apk and a system service, without linger or systemd', {skip}, async () => {
	const home = join(root, 'openrc')
	await mkdir(home)
	const bin = await openrcBin()
	const unit = join(home, 'openrc-unit')
	const r = install(home, bin, ['--server', 'https://192.168.1.20:7780', '--ca', CA, '--token', 'abc123', '--allow', 'terminal,desktop,manage,files'], {
		path: bin,
		FAKE_UNIT: unit,
	})
	assert.equal(r.status, 0, r.out)
	const log = await readFile(r.log, 'utf8')
	assert.match(log, /apk add --no-cache /)
	assert.doesNotMatch(log, /systemctl/)
	assert.doesNotMatch(log, /loginctl/)
	assert.match(log, /sudo tee \/etc\/init\.d\/omarchy-connector|tee \/etc\/init\.d\/omarchy-connector/)
	assert.match(log, /rc-update add omarchy-connector/)
	assert.match(log, /rc-service omarchy-connector start/)
	const written = await readFile(unit, 'utf8')
	assert.match(written, /command_user=["']?chris/)
	assert.match(written, /supervise-daemon/)
	assert.match(written, /\/run\/user\//)
	assert.match(r.out, /Alpine box" is now in your server/)
})

test('OpenRC --user-enroll-only enrolls without writing the system service', {skip}, async () => {
	const home = join(root, 'openrc-enroll')
	await mkdir(home)
	const bin = await openrcBin()
	const unit = join(home, 'openrc-unit')
	const r = install(home, bin, [...ARGS, '--user-enroll-only'], {path: bin, FAKE_UNIT: unit})
	assert.equal(r.status, 0, r.out)
	const log = await readFile(r.log, 'utf8')
	assert.equal(/sudo/.test(log), false, log)
	assert.doesNotMatch(log, /rc-update/)
	assert.doesNotMatch(log, /rc-service/)
	assert.match(log, /enroll https:\/\/192\.168\.1\.20:7780 abc123 terminal,desktop,manage,storage,files$/m)
	await assert.rejects(readFile(unit))
})
