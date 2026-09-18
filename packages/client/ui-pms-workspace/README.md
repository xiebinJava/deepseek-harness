# @deepseek-ai/dsh-client-ui-pms-workspace

Adds a PMS business-workspace tab to DSH's existing resizable right sidebar.
The tab embeds the real PMS frontend; it does not reproduce a second PMS UI
inside DSH and it never puts a PMS token in the iframe URL.

## Local setup

Install the runtime plugin and this client package into the DSH web profile,
then restart the profile after the bundle set changes:

```sh
dsh plugin --profile web add /Users/fs/Desktop/Project/deepseek-harness/packages/pms/dsh-pms
dsh plugin --profile web add /Users/fs/Desktop/Project/deepseek-harness/packages/client/ui-pms-workspace
```

The browser bundle reads `DSH_CLIENT_PMS_WORKSPACE_URL` at build time. If it is
unset, local development uses `http://127.0.0.1:5173/projects`. The URL is
loaded unchanged so the right pane shows the real PMS page, including its
topbar, sidebar, project management, and configuration management navigation.
PMS only enters its compact chrome mode when `embed=1` is explicitly present.
The workspace is closed by default; opening it associates the current DSH
session with PMS, while collapsing or closing it does not remove that session
association.

Production should point the variable at an allowlisted same-origin
`/pms-workspace/` route. Authentication is restored by the PMS/DSH server
session, not by query parameters or `localStorage` tokens.
