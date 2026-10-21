---
title: Device Pairing Contract
description: Security model for pairing a hosted RouterMCP console with a local daemon
---

# Device Pairing Contract

The hosted RouterMCP console connects directly to a daemon on the same
machine. Device pairing is the bridge between the hosted origin
(`https://cli.routermcp.com`) and that loopback control plane. The daemon
mounts the pairing routes on its authenticated HTTP transport and mints a
separate browser management credential on a successful exchange. It does not
bundle web code into the CLI.

## Security boundary

The managed daemon's `localAuthToken` protects its internal MCP, health, and
control-plane requests. It is private runtime state and must never be printed,
placed in a pairing URL, returned by an API, or handed to the browser.

Pairing uses a different, short-lived one-time grant. A valid exchange for a
grant with the `management` scope returns a fresh, short-lived management
credential for the browser in the `management` field. The daemon root token is
never part of the response.

The grant is bound to both:

- the daemon profile (`profileId`), so a token cannot cross configuration
  profiles; and
- the daemon instance (`instanceId`), so a restart invalidates grants issued by
  the previous process; and
- on a multi-workspace host, the workspace (`workspaceId`), so a grant issued
  for one workspace cannot be listed, revoked, or exchanged under another.
  Requests without `workspaceId` use the daemon's current workspace.

## Protocol

The contract is versioned independently from the daemon runtime protocol:

```text
PAIRING_PROTOCOL_VERSION = 1
POST   /api/v1/pairing/exchange      (grant + challenge; no bearer token)
POST   /api/v1/pairing/grants        (root token; issue a grant)
GET    /api/v1/pairing/grants        (root token; metadata only)
DELETE /api/v1/pairing/grants/:id    (root token; revoke a pending grant)
```

Issuance, listing, and revocation require the daemon's private root token, so
only a local process that can read the runtime manifest can create grants.
The exchange is the only unauthenticated pairing route: possession of the
one-time grant and its challenge is the credential. The routes are not mounted
at all when the daemon runs without an auth token. `GET` accepts
`includeInactive=true|false` and `workspaceId`; `DELETE` accepts only
`workspaceId`; the exchange accepts no query parameters. Request bodies are
limited to 4 KiB.

Errors use stable codes: unknown, expired, revoked, and already-consumed grants
return `404` (an unknown workspace on exchange is indistinguishable from an
unknown grant), a full grant store returns `429`, and invalid input or a
challenge mismatch returns `400`.

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

The remaining phases should add, in order:

1. a CLI command that issues a grant and opens the hosted console with the
   pairing link, plus hosted-console exchange wiring with fragment cleanup;
2. rate limits on the unauthenticated exchange route; and
3. peer management models/routes plus a UI that requests `peering:*` scopes
   explicitly and supports revocation and expiry states.

None of these phases may use or expose `localAuthToken` as a browser token.
