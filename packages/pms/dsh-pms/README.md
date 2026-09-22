# @deepseek-ai/dsh-pms

The DSH PMS integration plugin. It provides the shared PMS context/auth bridge
and, when mounted by the PMS Agent, exposes these PMS tools:

- `pms_project_list`
- `pms_project_get`
- `pms_task_list`
- `pms_people_list`
- `pms_query`
- `pms_command_preview`
- `pms_command_execute`

The command surface is **published by PMS capabilities, not hardcoded here**: the
plugin mounts whatever the current delegation publishes (`tools: ['*']`) and the
preview tool rejects a command name that PMS does not advertise. Adding a PMS
command therefore needs no change in this package. Node editing is generic too:

- `node.field.update` writes any node workbench field (one adapter per workbench in PMS),
- `batch.write` runs up to 20 registered writes behind one preview and one execution.

Which commands a node accepts comes from that node's Agent contract, which PMS
publishes per workflow node and the plugin resolves by `workflowNodeKeys`.

## Signing in

PMS identity and page context come from the DSH browser session. When the PMS
deployment enables `pms.dsh.sso-session-enabled` and this plugin has a
`serviceKey`, the host also exchanges the SSO ID token it already verified
(`browserIdentity` from `client-connection`) for a normal PMS session, persists
it through the credentials seam, and rotates it as needed. That is what makes a
plain DSH conversation work without the embedded PMS page, survive browser
refreshes, and stop the moment the user logs out of PMS (PMS revokes the
session it issued).

The plugin calls PMS only through `/api/integration/dsh/v1/*`. It does not read
the PMS database directly; PMS remains the source of business data and final
authorization.

## Runtime modes

Use `mode: host` for the profile-level plugin. It keeps the browser context and
authentication bridge available but does not register PMS tools or PMS prompt
text for generic Agents. The shipped `pms-project-assistant` preset mounts the
same plugin with `mode: agent`, which contributes the PMS tools and domain
prompt only to that Agent.

`mode: full` is retained for compatibility with older deployments and keeps
the previous all-in-one behavior. New deployments should use the split host /
Agent arrangement:

```yaml
# profile cordis.patch.yml
- id: pms
  config:
    mode: host
    baseUrl: http://127.0.0.1:8080
    apiPrefix: /api
```

The PMS Agent preset contains:

```yaml
- id: pms
  name: '@deepseek-ai/dsh-pms'
  config:
    mode: agent
```

## Local profile setup

Install it into a DSH profile with the DSH plugin manager:

```sh
dsh plugin --profile web add /Users/fs/Desktop/Project/deepseek-harness/packages/pms/dsh-pms
```

For the embedded PMS workspace, the browser sends a one-time PMS authorization
code to the DSH Host through the iframe bridge. The Host exchanges that code
with the PMS backend and keeps the returned short-lived `aud=dsh-pms` token in
memory per DSH session. The PMS user token and the service key are never sent
to the browser workspace or put into a URL.

Authentication priority is: explicit short-lived `accessToken`, then the
browser authorization code held by the current DSH session. A configured
`pmsUserToken` is **not** a browser-session fallback: it is ignored by default
and can only be enabled explicitly with `allowLegacyUserTokenExchange: true`
for a controlled headless or migration deployment. Never use a static
administrator token for a browser Agent session.

```yaml
- patch:
    - id: pms
      config:
        baseUrl: http://127.0.0.1:8080
        apiPrefix: /api
        pmsUserToken: !!js process.env.PMS_USER_ACCESS_TOKEN ?? ''
        serviceKey: !!js process.env.PMS_DSH_SERVICE_KEY ?? ''
        dshSessionId: !!js process.env.DSH_SESSION_ID ?? ''
        agentId: project_assistant
```

The PMS backend must have `PMS_DSH_SERVICE_KEY` configured with the same value.
The exchange endpoint also requires a normal PMS `Authorization: Bearer ...`
token, an active PMS session, and returns only the scopes granted by the PMS
user and Agent policy. The `accessToken` option remains available for local
development with an already issued short-lived delegation token:

```yaml
- patch:
    - id: pms
      config:
        baseUrl: http://127.0.0.1:8080
        apiPrefix: /api
        accessToken: !!js process.env.PMS_DSH_ACCESS_TOKEN ?? ''
```
