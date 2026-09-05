# Local management API

The managed daemon exposes a loopback-only control plane at `/api/v1`. The
browser credential returned by `POST /api/v1/management/handoff` is short-lived
and exists only in daemon memory.

## Host and workspace authority

Every handoff declares an `authority`:

- `host` grants may select any workspace already registered with the same local
  daemon host. The optional `workspaceId` in the response is the initial
  dashboard selection, not an authorization boundary.
- `workspace` grants retain the older behavior and may access only their
  claimed workspace.

The daemon must construct a host grant with
`ManagementCredentialStore({ authority: "host" })` and provide
`canIssueWorkspace` backed by the authenticated local workspace registry. The
callback is used only when a handoff requests an initial workspace claim; it
must reject IDs that are not registered. The browser cannot submit paths or
config contents to obtain a grant.

## Context routes

The dashboard selects a registered context explicitly. Its read routes are:

```text
GET /api/v1/workspaces
GET /api/v1/workspaces/:workspaceId/status
GET /api/v1/workspaces/:workspaceId/servers
GET /api/v1/workspaces/:workspaceId/features
GET /api/v1/workspaces/:workspaceId/sessions
GET /api/v1/workspaces/:workspaceId/metrics
GET /api/v1/workspaces/:workspaceId/events?limit=40
```

Configuration mutations use the selected workspace and an `If-Match` digest:

```text
PATCH /api/v1/workspaces/:workspaceId/servers/:serverId
PATCH /api/v1/workspaces/:workspaceId/features
```

The `serverId` must use `mcp:<name>` or `openapi:<name>`. A stale digest returns
`409` with the current digest. Unknown workspace IDs return a sanitized `404`.

## Context reload contract

`createConfigManagementSource` accepts a `reload` callback for isolated
workspace hosts. The callback runs after an atomic JSONC mutation and must
reconcile only its bound workspace while retaining the daemon host PID,
listener, and other workspace contexts. It may rebuild upstream connections,
capabilities, and sessions for that context. The mutation result exposes the
sanitized `reload` result and keeps `restartState` for compatibility with
older clients.

The legacy `restart` callback remains available for single-profile daemons. A
multi-workspace host must use `reload`; a workspace toggle must never invoke
the host-wide `ControlPlane.restart()` operation.

Workspace status, server snapshots, sessions, metrics, events, and management
adapters are supplied by `ControlPlaneSource` callbacks. Each callback must
return data for the requested registered workspace only. Paths are visible to
the authenticated local dashboard for diagnostics; config contents,
environment values, authorization headers, and upstream credentials are never
part of the control-plane response or audit metadata.
