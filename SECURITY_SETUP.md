# Security and user-access setup

Before deploying the Apps Script web app, add these Script Properties:

- `API_SECRET_KEY`: a newly generated random value. Requests now fail closed when it is absent.
- `AUTHORIZED_USERS_JSON`: a JSON allowlist for OTP login, for example:

```json
[
  {"email":"owner@example.com","role":"admin"},
  {"email":"cashier@example.com","role":"cashier"}
]
```

The temporary migration alternative is `AUTHORIZED_USERS`, a comma-separated email list. Those users receive the `cashier` role. Login-code requests are limited to five per address every 15 minutes.

The WhatsApp companion now binds to `127.0.0.1`; do not expose its port with a router or tunnel.

## Required follow-up

Rotate every credential previously embedded in the public web bundle, including API keys, passwords, PINs, and the Telegram bot token. A token delivered to a browser cannot be secret; for internet-facing deployments, use an authenticated server-side gateway rather than a shared client-side API key.
