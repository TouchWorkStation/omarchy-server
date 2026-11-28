# MODC Connect — development handoff (paused 2026-11-24)

Development is paused. This branch (`dev/modc-connect-sso-v2`) and the frozen branch `checkpoint/modc-connect-2026-11-24` hold all MODC Connect work. Nothing here is merged into `main`. The production server (Node Zero, `nodezero.myowndatacenter.com`) was moved back to the stable release (0.9.81 at the time of writing).

## 1. Completed functionality

| Area | What works | Where |
|---|---|---|
| Pairing (Phase 3) | Settings → MODC Connect: pairing code + QR, polling, heartbeats; device credential stored 0600, never sent to the browser, logs or telemetry | `omarchyd/connect.mjs`, `web/src/…` |
| Managed connector (Phase 5B) | `cloudflared` as user unit `modc-cloudflared.service`; tunnel token file 0600 (`ConditionFileNotEmpty`), never in process args; downloads a pinned `cloudflared` | `omarchyd/connect-tunnel.mjs` |
| Ingress policy / recovery | Runs only for `deny_all` or a verified `protected_route`; probes the public hostname (Access login redirect in v1, this server's gate in v2); unsafe/unprotected → stop + wipe token; recovers by itself when the website's state becomes safe again | `connect-tunnel.mjs` (`ingressPolicy`, `probeAccess`, `probeSsoGate`) |
| Remote access API v1 | `GET /remote-access` settings (§10), polled every 30 s, stale after 10 min → gate shuts; emergency disable; credential rotation flag shuts the gate | `omarchyd/connect-remote.mjs` |
| Remote gate | Dedicated listener `127.0.0.1:7781`; v1 = Cloudflare Access JWT (RS256, JWKS, aud/iss/host pinned); fails closed; forwarding headers from non-loopback stripped; legacy 7780 isolated | `server/remote-gate.mjs`, `server/access-jwt.mjs`, `server/app.mjs` |
| SSO v1 (behind Access) | PKCE + state, `/modc/auth/start` → website `/connect/authorize` → `/modc/auth/callback`; exchange/validate/revoke; session pinned to the Access subject; periodic validation closes open WebSockets on revoke | `omarchyd/connect-sso.mjs`, `server/app.mjs` |
| SSO-only gateway (contract v2) | All of `contract_version 2`, `protection_mode modc_sso`, `sso.stage sso_only`, `sso.enabled true`, `origin http://127.0.0.1:7781` must agree; signed out only the sign-in page/assets load; everything else 401 `x-modc-gate: sso_only`; no remote password sign-in; legacy 7780 → 421; WebSockets need a live website session | same files, commit `1e0d00d` |
| V2 readiness | Reports supported contract (2) + `sso_only_gate` once the v2 boundary passes a synthetic self-test (`x-modc-probe: sso_only`) while v1 is still active; outcome logged (`journalctl --user -u omarchyd.service \| grep readiness`) | commit `95b325a` |
| Branding | MODC logo and icons everywhere (no third-party marks) | `bf5325b`, `1eee844` |

## 2. Architecture and API contracts

- **omarchyd** (127.0.0.1:2021, user service `omarchyd.service`) owns pairing, the device credential, the tunnel, remote-access settings and SSO calls to the website. Machine HTTP uses `machinePost` (node:https) because Node's fetch adds `sec-fetch-mode`, which the website rejects (`browser_not_allowed`).
- **Web server** (`omarchy-server-web.service`): 7780 (LAN, HTTP+HTTPS, local password auth unchanged) and 7781 (remote listener, loopback only, every request gated). It asks omarchyd over `/internal/sso/{start,finish,check,logout}`.
- **Data** (`~/.local/share/omarchy-server/omarchyd/connect/`): `connect.json` (pairing + device credential), `tunnel.json`, `tunnel.token`, `cloudflared.yml`, `bin/`. The stable release ignores this folder; keep it.
- **Website endpoints** (`https://myowndatacenter.com/api/public/cloud`): pairing/heartbeat; `tunnel/status`, `tunnel/token`; `remote-access` (GET, §10 fields: `api_version`, `state`, `enabled`, `selected_connector`, `config_version`, `hostname`, `device_id`, `data_center_id`, `origin`, `access.{audience,issuer,certs_url,jwt_header,algorithms}`, `credentials.rotation_required`, `security.{contract_version,protection_mode}`, `sso.{enabled,available,stage,contract_version,authorization_endpoint,callback_path}`); SSO `/sso/{exchange,validate,revoke,readiness,activate}`; browser `/connect/authorize`. Rate limits: validate+revoke 120/min; readiness+activate 6/10 min; remote-access+tunnel status 30/10 min.
- **Readiness body**: `{contract_version: 2, config_version, origin: "http://127.0.0.1:7781", app_version, checks: {pkce, state, session_validation, fail_closed, host_only_cookie, legacy_origin_isolated, sso_only_gate}}`.
- **v2 tunnel status must keep** `ingress: protected_route`, `remote_access.enabled: true`, `state: enabled`, and `remote_access.security: {contract_version: 2, protection_mode: "modc_sso"}`; the SSO exchange must return `protection_mode: modc_sso`, `sso_stage: sso_only`.
- The server never calls `activate`, never holds a Cloudflare API token and never changes Cloudflare.

## 3. Branches and commits

| Branch | Head | Contents |
|---|---|---|
| `dev/modc-connect-sso-v2` (**resume here**) | this commit; code at `95b325a` | everything below + SSO-only gateway + v2 readiness |
| `dev/modc-connect-sso` | `aa219cd` | SSO behind Access (production-tested) |
| `fix/connector-protected-route` | `b5d8b5d` | connector protected-route compatibility + recovery |
| `dev/modc-connect-remote-v1` | `46bba0f` | Access JWT gate, 7781 listener, emergency disable |
| `dev/modc-connect` | `bf5325b` | consolidated 0.9.76 build: pairing, tunnel, 6A, logo |
| `feat/modc-connect`, `feat/modc-connect-tunnel`, `feat/modc-connect-remote` | `b19d172`, `36d9566`, … | earlier phase branches |

Code base: 0.9.76 (merge base `f2f41e2`); `main` has moved on (0.9.81, `06d3096`). Rebase/merge `main` in before resuming.

## 4. Successful production tests (Node Zero)

- Device pairing, domain reservation, DNS automation, tunnel provisioning and credential delivery.
- Connector online with the protected route; automatic recovery after the "unsafe" block (b5d8b5d).
- MODC SSO behind Cloudflare Access (aa219cd): sign-in, session, remote use.
- Local v1 boundary checks: 403 on both ports as expected; 7780 and 7781 listening.
- V2 readiness (contract 2, `sso_only_gate: true`) accepted by the website (95b325a).
- Origin migration to `http://127.0.0.1:7781` succeeded.

Automated: 65 focused tests for 1e0d00d, 34 readiness tests for 95b325a (`test/sso-only.test.mjs`, `connect-sso`, `connect-remote`, `remote-gate`, `remote-access`, `connect-tunnel`, `connect`).

## 5. Outstanding bugs and blockers

1. **Final v2 activation failed** on the website; it reported `rollback_failed` at `config_version 4`. Website-side (Lovable); cause not yet diagnosed.
2. **Cloudflare's published application route is missing** after the failed activation/rollback. Must be restored by the website (not by this server) before any tunnel runs again.
3. **`modc-cloudflared.service` was stopped manually**, and is disabled as part of the move to the stable release (so it can't start at boot). The tunnel, token, DNS reservation and device pairing were kept. Do not re-enable it until 1 and 2 are resolved and the website reports a safe, verified state.
4. Remote-access protection state is unresolved: treat the hostname as unprotected until externally verified (signed out: `/api/prefs`, `/api/rpc/user.get` → 401 with `x-modc-gate: sso_only` in v2, or the Access login in v1; terminal WebSocket refused).
5. The dev branch is based on 0.9.76 and needs `main` (0.9.81: `INSTALLER_REVISION 5`, `KillMode=process`, etc.) merged before the next production install.

## 6. Resuming development

```
git clone https://github.com/MyOwnDataCenter/server && cd server
git checkout dev/modc-connect-sso-v2          # or the frozen copy: git checkout checkpoint/modc-connect-2026-11-24
git merge origin/main                         # bring in 0.9.81+, resolve, re-run tests
node --test test/sso-only.test.mjs test/connect-sso.test.mjs test/connect-remote.test.mjs \
  test/remote-gate.test.mjs test/remote-access.test.mjs test/connect-tunnel.test.mjs test/connect.test.mjs
```
First tasks: (1) with Lovable, diagnose `rollback_failed` at config_version 4 and restore the published route, (2) confirm the website's v1/v2 state from `GET /remote-access` and `tunnel/status`, (3) only then install the dev build on Node Zero (put back `~/.local/share/omarchy-server/omarchyd/update-hold`), and re-enable the connector with `systemctl --user enable modc-cloudflared.service` once the state is safe — omarchyd's policy check still decides whether it runs.

## 7. Remaining requirements for automated customer onboarding

- Merge to `main` only after: activation and rollback work end to end, the published route is managed atomically by the website, and external verification (outside, no cookies) is automated before and after each switch.
- Website: transactional activate/rollback with the 7780 route kept for rollback; `config_version` bump per change; readiness freshness enforced; clear error states surfaced to the server (`GET /remote-access`).
- Server: Settings UI states for "activation pending / failed / rolled back"; a one-click "turn off remote access" that also stops and disables the connector; cleanup of the connector on unpair.
- Onboarding flow: pair → reserve domain → provision tunnel (`deny_all`) → v1 Access → SSO behind Access → readiness v2 → activate SSO-only, each step verifiable and reversible without manual Cloudflare work.
- Release hygiene: installer revision handling for the new unit, CI green, and an installer path that never starts the connector before the policy check.
