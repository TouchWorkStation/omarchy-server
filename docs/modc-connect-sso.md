# MODC Connect: website sign-in (planned, not active)

Nothing here is switched on. This is how signing in to a server with a myowndatacenter.com account
will fit in, once the website's sign-in endpoints exist. Until then the server's own accounts are the only
way in, at home and remotely.

## Flow (OpenID Connect, authorization code with PKCE)

1. The sign-in page offers "Sign in with myowndatacenter.com" only when the website has published its
   endpoints and the owner has turned it on here (Settings › MODC Connect). Off by default.
2. The server makes a `state`, a `nonce` and a PKCE `code_verifier` (S256), keeps them server-side for
   that browser only (never in the page), and sends the browser to the website's authorize endpoint with
   this server's registered client ID and its exact redirect address.
3. The website signs the person in and returns a single-use code that expires after 60 seconds, bound to
   this device and this server's audience.
4. The server swaps the code (with the verifier and its device credential) for an ID token, then checks:
   the signature against the website's published keys, issuer, audience = this device, `nonce`, expiry,
   and that `state` matches.
5. The website account is mapped to a local account only if the owner approved that link here
   beforehand (Settings › Users). No match, no sign-in: the website never creates or promotes local
   accounts, and an owner link always needs the owner's explicit approval on this server.

## Never

- Passwords are never synchronised between the website and the server.
- A website session cookie or token is never accepted as a sign-in here; only the checked ID token from
  step 4, once, to start a normal local session.
- A Cloudflare Access token is never a sign-in either (it only gets a browser to the sign-in page).

## Where it will plug in

- `server/app.mjs`: `/api/auth/sso/start` and `/api/auth/sso/callback`, next to `/api/auth/login`, using
  the same session store, sign-in limits and remote-session binding.
- `omarchyd/connect.mjs`: the website's issuer, keys address and client registration, read with the device
  credential like the remote-access settings.
