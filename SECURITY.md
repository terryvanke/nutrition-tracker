# Security Policy

## Supported versions

Security fixes are applied to the latest release and the `main` branch.

## Reporting a vulnerability

Please do not open a public issue for an unpatched vulnerability. Use GitHub's private vulnerability reporting feature for this repository. Include affected versions, reproduction steps, impact, and any suggested mitigation.

Do not include real API keys, Firebase credentials, personal health records, or access tokens in a report.

## Security design

- API keys are session-only and excluded from cloud sync and exports.
- Public CORS proxies are not supported.
- Firestore paths are restricted to the authenticated owner.
- User and AI content is escaped before HTML rendering.
- A Content Security Policy blocks inline scripts and event handlers.
- Firestore Rules authorization tests run in CI.

