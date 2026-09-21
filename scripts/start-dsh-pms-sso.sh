#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# DSH launch-sensitive variables must be exported by the launching environment,
# not loaded from .env. The public dsh-web client uses Authorization Code + PKCE.
export DSH_OIDC_ENABLED=true
export DSH_OIDC_ISSUER="http://127.0.0.1:8180/realms/pms"
export DSH_OIDC_CLIENT_ID="dsh-web"
export DSH_OIDC_REDIRECT_URI="http://127.0.0.1:3080/auth/oidc/callback"

exec node apps/cli/lib/bin.js web --host 127.0.0.1 --port 3080 "$@"
