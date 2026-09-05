---
title: Device Pairing Contract
description: Security model for pairing a hosted RouterMCP console with a local daemon
---

# Device Pairing Contract

The hosted RouterMCP console will eventually connect directly to a daemon on
the same machine. Device pairing is the planned bridge between the hosted
origin (`https://cli.routermcp.com`) and that loopback control plane. This
phase defines the contract and process-local grant store; it does not mount
pairing routes, mint a browser credential, or bundle web code into the CLI.

## Security boundary

The managed daemon's `localAuthToken` protects its internal MCP, health, and
control-plane requests. It is private runtime state and must never be printed,
placed in a pairing URL, returned by an API, or handed to the browser.

Pairing uses a different, short-lived one-time grant. After a valid exchange,
a later implementation will mint a separate scoped management credential for
the browser. The grant exchange result in this phase is only an authorization
decision and contains no bearer credential.

The grant is bound to both:

- the daemon profile (`profileId`), so a token cannot cross configuration
  profiles; and
- the daemon instance (`instanceId`), so a restart invalidates grants issued by
  the previous process.

## Protocol

The contract is versioned independently from the daemon runtime protocol:

```text
PAIRING_PROTOCOL_VERSION = 1
POST /api/v1/pairing/exchange       (reserved; not mounted yet)
POST /api/v1/pairing/grants         (reserved; issuance is CLI-owned)
GET  /api/v1/pairing/grants         (reserved; metadata only)
DELETE /api/v1/pairing/grants/:id   (reserved; revocation)
```

An issuer creates a grant with an explicit scope set and receives the opaque
credential exactly once. It also receives a separate high-entropy challenge
nonce:

```json
{
  "protocolVersion": "1",
  "grant": "<opaque credential>",
  "challengeId": "<uuid>",
  "nonce": "<opaque challenge nonce>"
}
```

The browser receives the grant and challenge through a pairing link. The link
should carry these values in the URL fragment so they are not sent as HTTP
referer or request-query data. The hosted page should read the fragment and
remove it from the address bar immediately, as it does for other sensitive
one-time handoffs.

The daemon accepts an exchange only when all of the following match:

1. protocol version is supported;
2. grant credential is valid and belongs to the current profile and instance;
3. challenge id and nonce match the same grant; and
4. the grant is pending and has not expired or been revoked.

The successful transition is atomic: `pending → consumed`. Replaying the same
credential fails and cannot mint another browser session. A bad challenge does
not consume a pending grant, allowing a legitimate client to retry without
issuing another grant.

## Scopes

Scopes are capabilities and must be checked by every future route handler:

| Scope | Intended use |
| --- | --- |
| `management` | initial hosted-console management API (snapshots and restart) |
| `peering:read` | future peer inventory and connection state |
| `peering:write` | future peer add/remove/update operations |

New grants default to `management`, matching the management credential issued
by the preceding CLI phase. The peering scopes are reserved and are not implied
by management access; the initial store rejects them even when they are
syntactically valid. Fine-grained read/write management scopes can be added in
a later authorization phase after route-level checks are in place.

## Lifetime and storage

Grant TTL is five minutes by default, with a hard lower bound of 30 seconds and
upper bound of 15 minutes. The store keeps only SHA-256 digests of credentials
and challenge nonces; list/status records never contain either secret. It
maintains pending, consumed, revoked, and expired metadata for bounded local
diagnostics, evicting terminal records when its capacity is reached.

The initial store is process-local and intentionally not persisted. A daemon
restart changes `instanceId`, which makes old grants unusable and avoids
introducing a second persistent secret store before the management credential
design is finalized.

## Deferred work

The next implementation phases should add, in order:

1. a separately stored/rotated management credential and authenticated route
   middleware that maps scopes to the existing control-plane endpoints;
2. CLI issuance and hosted-console exchange wiring, including fragment cleanup,
   exact-origin CORS, and rate limits; and
3. peer management models/routes plus a UI that requests `peering:*` scopes
   explicitly and supports revocation and expiry states.

None of these phases may use or expose `localAuthToken` as a browser token.
