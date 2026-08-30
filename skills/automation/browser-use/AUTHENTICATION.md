# Authentication

The shared Vivaldi profile already carries the user's browser authentication. Prefer an existing authenticated task tab or let the user complete login in the visible browser.

Read [TRUST-BOUNDARIES.md](TRUST-BOUNDARIES.md) before handling credentials, cookies, auth state, OAuth, SSO, or 2FA.

## Login

Navigate to the requested login page, snapshot the form, and let the user use browser-native password-manager or passkey UI when available:

```bash
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab \
  open https://app.example.com/login
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab snapshot -i
```

Credentials stay out of shell arguments, scripts, logs, and conversation text. If direct credential entry is required, ask the user to perform it in Vivaldi.

After the user finishes, verify the authenticated state from the URL and a fresh snapshot:

```bash
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab \
  wait --url "**/dashboard" --timeout 120000
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab snapshot -i
```

**Complete when:** the page visibly shows the intended authenticated account and destination.

## OAuth, SSO, passkeys, and 2FA

Keep the task tab open while the user completes identity-provider redirects, hardware prompts, passkeys, CAPTCHA, or one-time codes. Re-snapshot after every redirect before interacting again.

Obtain confirmation before:

- Adding or removing authentication methods.
- Granting OAuth scopes or third-party access.
- Changing the signed-in account.
- Trusting a new device.

**Complete when:** the redirect returns to the requested application and the account state is verified.

## Cookies and storage

The attached Vivaldi profile shares cookies and storage with the user's normal browsing. Reading or changing them affects that profile.

Use cookie or storage commands only when the task explicitly requires them. Inspect only the named origin and never print secret values. Clearing cookies or storage requires explicit approval.

State exports contain bearer credentials in plaintext. Create one only when the user requests it, keep it local with restrictive permissions, report its path without reading its contents, and delete it when the requested use ends.

**Complete when:** the smallest required auth state change is verified without exposing secret values.
