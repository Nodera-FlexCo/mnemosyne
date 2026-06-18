# Implementation Plan: Public OAuth-Protected Remote MCP Connector (memory + codebase, never secrets)

**Task:** Open the Mnemosyne MCP stack so `memory-mcp` (8080) and `codebase-mcp` (8081) — but **NEVER** `secrets-mcp` (8082) — are reachable from Claude Desktop, Cowork, and claude.ai as a public, OAuth-protected, Streamable-HTTP custom connector via a Cloudflare Tunnel, with an `mcp-remote` stdio bridge as a Desktop-only fallback, **without** breaking the existing Claude Code localhost path or the loopback-only DB/Redis posture.

**Approach:** "Probe Approach 2, then build Approach 1." Land the git foundation + the network/origin security fixes first. Then time-box a probe of **Cloudflare Access Managed OAuth** (Approach 2). If the probe passes the connector matrix → ship CF Access and **skip Phase 2**. If it fails → build the **self-hosted OAuth 2.1 AS** (`mnemo-auth`, Approach 1). Phase 3 (Desktop fallback + verification gates + docs) runs regardless of which auth path shipped.

**Estimated scope:** ~10 files to create, ~12 files to modify (Phase 0 + Phase 1). Phase 2 (conditional) adds ~8 files to create, ~6 to modify.

**Layers:** infrastructure (Docker Compose, Cloudflare Tunnel/Access, systemd), backend (3× MCP Node/Express services — no shared package), database (Postgres token store, Phase 2 only), docs.

---

## Grounded facts (verified against /opt/mnemosyne, do not re-derive)

- **No shared package.** `memory-mcp`, `codebase-mcp`, `secrets-mcp` each have their **own** `src/config.ts` + `src/auth.ts` + `src/server.ts`. Every code change is duplicated: **2× (memory+codebase)** for the public path, **3×** when secrets-mcp must also change defensively. Each step states its multiplier.
- **`MnemoAuth` shape** (`services/*/src/auth.ts`): `{ token, clientId, scopes, extra: { projectId } }`. Tool handlers read `auth.extra.projectId` via `(req as Request & { auth?: MnemoAuth }).auth`. Any new auth path MUST populate this exact shape.
- **Current auth** (`requireBearer`): static `MNEMO_TOKEN` compare; if unset, runs open. Mounted as `app.use(requireBearer)` AFTER `/healthz` and BEFORE `/mcp`. The file comment already anticipates swapping it for an OAuth `TokenVerifier`.
- **Transport** (all three `server.ts`): `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })` — stateless, no SSE, no sticky sessions. `app.listen(config.port, '0.0.0.0', …)` — binds all interfaces. **Verified.**
- **SDK** = `@modelcontextprotocol/sdk@1.29.0` (pinned in every `package.json` + lockfile). This version ships `server/auth/router.js` (`mcpAuthRouter`), `requireBearerAuth`, `ProxyOAuthServerProvider`, and `getOAuthProtectedResourceMetadataUrl` — the Phase 2 building blocks. **Confirm the exact export paths via Context7 before writing code (the SDK auth API moved between minors).**
- **Networking (EMPIRICALLY VERIFIED on the box):**
  - `backend` network is `internal: true`.
  - A container attached to an **internal-only** network **cannot** have a published port reached from host loopback → `curl 127.0.0.1:PORT` returns **HTTP 000**.
  - Attaching the same container to **any non-internal** network restores the loopback publish → **HTTP 200**.
  - **Therefore the compose comment is CORRECT: `edge` is what makes `127.0.0.1:8082` work for secrets-mcp.** Naively deleting `edge` from secrets-mcp **breaks loopback 8082**. The fix is NOT "remove edge" — it is "move secrets-mcp off the cloudflared-shared `edge` net onto a dedicated non-internal `loopback` net that cloudflared is NOT on." See Step 5.
  - `postgres` and `langfuse` also carry `edge` for the same loopback-publish reason — leave them (postgres publishes 5432, langfuse 3000 to loopback). Out of scope; do not touch.
- **cloudflared, mnemo-auth do not exist yet.** README still lists "Stage 0: cloudflare tunnel" as unchecked. `docs/` does not exist yet — create it.
- **Apply changes** = `docker compose up -d --build [service]`, then optionally `systemctl restart mnemosyne` (systemd unit is `Type=oneshot` running `docker compose up -d --remove-orphans`). **No `--no-verify`** anywhere (git hooks are introduced by us; honor them).

---

## Prerequisites

- [ ] A Cloudflare account with a zone (domain) delegated to Cloudflare DNS. Capture the apex domain as `${DOMAIN}` (e.g. `mnemo.example.com` host pattern → `memory.${DOMAIN}`, `codebase.${DOMAIN}`, `auth.${DOMAIN}`).
- [ ] A Cloudflare **named tunnel** created (dashboard: Zero Trust → Networks → Tunnels, OR `cloudflared tunnel create mnemosyne`). Capture the **tunnel token** (`TUNNEL_TOKEN`) and/or the **credentials JSON** (`<TUNNEL_ID>.json`).
- [ ] `${VOYAGE_API_KEY}`, `${MNEMO_TOKEN}`, `${SECRETS_MASTER_KEY}` already in `.env` on the box (existing). `MNEMO_TOKEN` MUST be set (non-empty) — the loopback bypass in Phase 2 still relies on it for Claude Code over 127.0.0.1.
- [ ] Decide the public hostnames now; they are baked into ingress rules, Origin allowlists, OAuth redirect-URI registration, and the connector URL.

---

## Acceptance Criteria (EARS)

<!-- Stable IDs; never renumbered. Each is externally observable + verifiable. -->

- **AC-001** — WHEN an HTTP request arrives at `memory-mcp` or `codebase-mcp` from the public Cloudflare Tunnel without valid credentials, the system SHALL respond `401` with a `WWW-Authenticate` header that points clients to the OAuth metadata (resource metadata URL), and SHALL NOT execute any MCP tool.
- **AC-002** — WHEN Claude Code (or `mcp-remote`) connects over `http://localhost:8080-8082/mcp` from the host machine with the existing `MNEMO_TOKEN` bearer (or open, if unset), the system SHALL serve MCP requests exactly as before this change (no regression).
- **AC-003** — IF a request carries an `Origin` header that is not in the configured public-origin allowlist, THEN `memory-mcp` and `codebase-mcp` SHALL reject it with `403` before any auth or tool execution (DNS-rebinding guard per MCP spec).
- **AC-004** — WHILE the stack is running, `secrets-mcp` (8082) SHALL be reachable ONLY from host loopback (`127.0.0.1:8082`) and SHALL NOT be reachable through any Cloudflare Tunnel ingress hostname (no route exists, and it is not attached to the cloudflared-shared network).
- **AC-005** — WHILE the stack is running, Postgres (5432) and Redis (6379) SHALL remain published to `127.0.0.1` only and SHALL remain on the `internal:true backend` network (no new public exposure).
- **AC-006** — WHEN the public OAuth flow completes for `memory.${DOMAIN}` or `codebase.${DOMAIN}`, the system SHALL register BOTH `https://claude.ai/api/mcp/auth_callback` AND `https://claude.com/api/mcp/auth_callback` as valid redirect URIs.
- **AC-007** — WHEN a public request passes OAuth, the MCP tool handler SHALL receive a populated `MnemoAuth` object with `extra.projectId` set (default `DEFAULT_PROJECT_ID`), so existing per-project tool behavior is unchanged.
- **AC-008** — (Token persistence) WHEN a user (a) first connects the custom connector, (b) the tool list loads, (c) Claude Desktop is fully restarted (Cmd-Q + relaunch), and (d) the access token expires, THEN the connector SHALL still load tools without a manual re-auth in cases (a)–(c) and SHALL silently refresh in case (d). (Whichever auth path ships must pass all four.)
- **AC-009** — IF a public-origin request attempts to reach the `/mcp` endpoint, THEN it SHALL NOT be able to take the loopback bypass; the bypass SHALL be keyed off the container-internal source (cloudflared edge-network peer vs host-gateway loopback), NEVER off a client-supplied header (`Host`, `X-Forwarded-For`, `Origin`). (Phase 2 only.)
- **AC-010** — WHEN `git status` is run after Phase 0, `.env`, `backups/`, `node_modules/`, `dist/`, and the cloudflared credentials/cert files SHALL be untracked (gitignored); the secret values SHALL NOT appear in any committed file.
- **AC-011** — (Stateless invariant) WHEN a public MCP request transits cloudflared (and any proxy), the `POST` body, `Authorization`, `Accept`, `MCP-Protocol-Version`, and `Origin` headers SHALL be preserved intact, and no sticky-session affinity SHALL be required (`sessionIdGenerator: undefined`).
- **AC-012** — (Desktop fallback safety) WHERE the `mcp-remote` stdio bridge is documented for Claude Desktop, the documentation SHALL pin `mcp-remote >= 0.1.16`, use `--transport http-only`, and pass the bearer via an env-var value with NO space around the `Authorization:` colon.

---

## Steps

### PHASE 0 — git init + foundation (every downstream path needs this)

### Step 1: Initialize git + harden `.gitignore`
<!-- <task id="1" status="completed" file="/opt/mnemosyne/.gitignore" action="modify" depends="" /> -->
**What:** Make `/opt/mnemosyne` a git repo and ensure no secret/credential/build artifact can ever be committed.
**Files:** `/opt/mnemosyne/.gitignore` (modify — EXTEND, do not clobber the existing 13-line file), repo init.
**Pattern:** Existing `.gitignore` already ignores `.env`, `secrets/`, `node_modules/`, `dist/`, `*.tsbuildinfo`, `*.log`, `.DS_Store`.
**Details:**
- `git init` in `/opt/mnemosyne` (default branch `main`).
- Append (do NOT remove existing lines) to `.gitignore`:
  - `backups/` (DB dumps live here — verified: contains `memory-*.sql.gz`, canonical tarballs).
  - `cloudflared/*.json` (tunnel credentials `<TUNNEL_ID>.json`).
  - `cloudflared/cert.pem` (origin cert from `cloudflared tunnel login`).
  - `compose.yaml.bak.*` (the existing `compose.yaml.bak.20260617` backup).
  - `consolidated/`, `distill-src/`, `import-src/`, `services/importer/condensed/` only if they contain machine-local scratch (CHECK first with `git status --porcelain`; if they are source-of-truth, leave tracked). Default: leave tracked unless they contain secrets.
- Do NOT add a global ignore for `*.yml`/`*.yaml` (we need `cloudflared/config.yml` tracked).
- Verify nothing sensitive is staged: `git add -A && git status --porcelain | rg -i 'env|cred|secret|\.json$|backups' ` — confirm `.env`, `backups/`, `cloudflared/*.json` are absent from the staged list.
**Depends on:** none
**Verify:** `git status --porcelain` shows `.env` and `backups/` as ignored (not listed); `git check-ignore .env backups/ cloudflared/test.json` prints all three. **(AC-010)**
**Gotcha:** `.env` already exists and is `chmod 600`. Confirm it's ignored BEFORE the first `git add -A` — a single accidental commit of `.env` leaks Postgres/Redis/Voyage/secrets-master credentials into history.

### Step 2: Pre-commit secret-scan hook (lefthook or native git hook)
<!-- <task id="2" status="completed" file="/opt/mnemosyne/.githooks/pre-commit" action="create" depends="1" /> -->
**What:** A lightweight pre-commit guard so credentials can never be committed even by mistake — this repo will start carrying tunnel/OAuth material.
**File:** `/opt/mnemosyne/lefthook.yml` (create) OR `/opt/mnemosyne/.githooks/pre-commit` (create) — pick lefthook if `npx lefthook` is acceptable on the box; otherwise a plain shell `pre-commit` referenced via `git config core.hooksPath .githooks`.
**Pattern:** Mirror the nodex repo's pre-commit philosophy (gitleaks-if-present, degrade to a grep hint when absent) — but keep it dependency-free here (no pnpm workspace on this box).
**Details:**
- pre-commit: run `gitleaks protect --staged --no-banner` if `gitleaks` is on PATH; else a `git diff --cached` grep for high-signal patterns (`TUNNEL_TOKEN=`, `BEGIN .*PRIVATE KEY`, `SECRETS_MASTER_KEY=`, 40-hex Voyage keys) that exits non-zero on a hit.
- This is the box's only hook; honor it. Never `--no-verify`.
**Depends on:** Step 1
**Verify:** `echo 'TUNNEL_TOKEN=abc' > /tmp/x && git add -f /tmp/x` then attempt commit → hook blocks it. Clean up.
**Gotcha:** Don't make the hook require network or a pnpm install — the box runs a minimal toolchain.

### Step 3: Create `cloudflared` config + compose service (no inbound host ports)
<!-- <task id="3" status="completed" file="/opt/mnemosyne/cloudflared/config.yml" action="create" depends="1" /> -->
**What:** Add cloudflared as a compose service that dials OUT to Cloudflare (no published host ports) and routes ONLY the two public hostnames to memory/codebase; everything else 404s. **No route for secrets-mcp.**
**Files:** `/opt/mnemosyne/cloudflared/config.yml` (create), `/opt/mnemosyne/compose.yaml` (modify — add service).
**Pattern:** Existing compose service blocks (`memory-mcp`) for the `<<: *restart`, `networks`, `mem_limit` conventions. cloudflared official image `cloudflare/cloudflared:latest` (pin a digest/tag in the plan PR).
**Details:**
- `cloudflared/config.yml` ingress (ORDER MATTERS — first match wins, catch-all last):
  ```yaml
  tunnel: ${TUNNEL_ID}            # or rely on token; if using token, config.yml ingress is set in dashboard instead
  credentials-file: /etc/cloudflared/<TUNNEL_ID>.json
  ingress:
    - hostname: memory.${DOMAIN}
      service: http://memory-mcp:8080
    - hostname: codebase.${DOMAIN}
      service: http://codebase-mcp:8081
    # NO secrets-mcp entry — ever.
    - service: http_status:404      # catch-all
  ```
  Note: if you run the tunnel **token-based** (`TUNNEL_TOKEN`), ingress is configured in the Cloudflare dashboard and `config.yml` is not read — in that case document the dashboard ingress equivalently and STILL keep a `config.yml` for reproducibility. Decide one mode and state it; **prefer credentials-file + local `config.yml` so the routing is in git** (auditable that secrets-mcp has no route).
- compose service:
  ```yaml
  cloudflared:
    image: cloudflare/cloudflared:2024.x.x   # pin
    <<: *restart
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: ${TUNNEL_TOKEN:-}        # only if token-mode
    volumes:
      - ./cloudflared:/etc/cloudflared:ro     # config.yml + <TUNNEL_ID>.json (gitignored)
    networks: [edge]                          # MUST reach memory-mcp + codebase-mcp; MUST NOT be on secrets-mcp's net
    # NO `ports:` — outbound tunnel only
    depends_on:
      memory-mcp: { condition: service_healthy }
      codebase-mcp: { condition: service_healthy }
  ```
- The `<TUNNEL_ID>.json` credentials file is placed in `./cloudflared/` out-of-band (scp'd to the box, never committed — gitignored in Step 1).
**Depends on:** Step 1 (gitignore must protect credentials first)
**Verify:** `docker compose config` resolves; `docker compose up -d --build cloudflared` → `docker compose logs cloudflared` shows "Registered tunnel connection" with 4 edge connections and NO error about secrets. `docker port mnemosyne-cloudflared-1` lists nothing (no inbound). **(AC-004 partial)**
**Gotcha:** cloudflared MUST be on the `edge` network (same as memory-mcp/codebase-mcp) to DNS-resolve `memory-mcp:8080`. It MUST NOT be added to whatever network secrets-mcp lands on (Step 5). Pin the cloudflared image tag — `latest` drift has broken QUIC connectivity before.

### Step 4: `.env.example` + `.env` keys for the tunnel + public origins
<!-- <task id="4" status="completed" file="/opt/mnemosyne/.env.example" action="modify" depends="3" /> -->
**What:** Document the new env keys; add the live values to `.env` on the box.
**Files:** `/opt/mnemosyne/.env.example` (modify), `/opt/mnemosyne/.env` (modify on box — NOT committed), optionally `/opt/mnemosyne/Makefile` (modify — add the new keys to the idempotent `secrets`/`add` pattern where they are generatable).
**Pattern:** Existing `.env.example` (4 keys) + the Makefile `add()` idempotent appender.
**Details:**
- Add to `.env.example` (templated, no secrets):
  - `DOMAIN=example.com`
  - `TUNNEL_TOKEN=__set_on_box__` (if token-mode) or `TUNNEL_ID=__set_on_box__`
  - `PUBLIC_ORIGIN=https://memory.example.com` (primary)
  - `ALLOWED_ORIGINS=https://memory.example.com,https://codebase.example.com` (comma-list for the Origin guard, Step 6)
  - Phase-2-only keys (add now, used later): `MNEMO_OAUTH_ISSUER=https://auth.example.com`, `OAUTH_DB_SCHEMA=oauth`.
  - Phase-1-(CF Access)-only keys: `CF_ACCESS_TEAM_DOMAIN=yourteam.cloudflareaccess.com`, `CF_ACCESS_AUD=__set_on_box__` (the Access app AUD tag).
- Keep secret values out of `.env.example`; real values go in `.env` (chmod 600, gitignored).
**Depends on:** Step 3
**Verify:** `docker compose config` shows `cloudflared` env resolved without `?set in .env` errors. `git check-ignore .env` still passes. **(AC-010)**
**Gotcha:** `MNEMO_TOKEN` must stay set in `.env` — do not let this change null it out; the loopback path (AC-002) and Phase-2 bypass both reference it.

### Step 5: SECURITY FIX — take secrets-mcp off the cloudflared-shared network (keep loopback 8082 working)
<!-- <task id="5" status="completed" file="/opt/mnemosyne/compose.yaml" action="modify" depends="3" /> -->
**What:** Ensure cloudflared can NEVER reach secrets-mcp, while preserving `127.0.0.1:8082` for the Desktop bridge / host admin.
**File:** `/opt/mnemosyne/compose.yaml` (modify).
**Pattern:** Existing `networks:` top-level block + per-service `networks:` lists.
**Details (CORRECTED from the naive "remove edge" — see verified networking facts):**
- **Do NOT just delete `edge` from secrets-mcp.** Empirically verified on this box: a container on the `internal:true backend` net only would have its `127.0.0.1:8082` publish return **HTTP 000** (internal networks block published-port reachability). The compose comment on line ~190 is CORRECT.
- Add a new top-level network: `loopback: {}` (non-internal, but cloudflared is NOT attached to it).
- Change `secrets-mcp` `networks:` from `[backend, edge]` → `[backend, loopback]`. This keeps the loopback publish working (non-internal `loopback` net) AND removes it from `edge` (where cloudflared lives), so cloudflared cannot DNS-resolve or route to `secrets-mcp`.
- Leave `memory-mcp` and `codebase-mcp` on `[backend, edge]` — they legitimately need `edge` for cloudflared ingress + Voyage egress.
- Confirm secrets-mcp `ports:` stays `"127.0.0.1:8082:8082"` (loopback only). Do NOT add any cloudflared ingress for it (Step 3 already omits it).
- Update the inline comment on secrets-mcp to explain the new posture (off `edge` so cloudflared can't reach it; on `loopback` so host publish still works; makes NO outbound calls).
**Depends on:** Step 3
**Verify:**
1. `docker compose up -d --build secrets-mcp cloudflared` then `curl -s -m3 http://127.0.0.1:8082/healthz` → `{"ok":true,...}` (loopback STILL works).
2. From inside cloudflared: `docker compose exec cloudflared sh -c 'wget -qO- http://secrets-mcp:8082/healthz || echo UNREACHABLE'` → **UNREACHABLE** (DNS fails — not on a shared net). This is the security assertion.
3. `docker network inspect mnemosyne_edge` → secrets-mcp NOT in the container list; memory-mcp + codebase-mcp + cloudflared ARE.
**(AC-004, AC-005)**
**Gotcha:** This is the one place where the task's literal instruction ("remove edge from secrets-mcp") would have **broken loopback 8082**. The verified fix is "swap edge → a dedicated loopback net." If the team prefers minimal nets, an alternative is to keep secrets-mcp on `edge` BUT verified that is rejected — cloudflared on `edge` could then reach `secrets-mcp:8082` by container DNS regardless of the missing ingress route, so it MUST be isolated.

### Step 6: Origin-validation middleware on memory-mcp + codebase-mcp (2× edit) — and defensively on secrets-mcp (3×)
<!-- <task id="6" status="completed" file="services/memory-mcp/src/origin.ts" action="create" depends="4" /> -->
**What:** Add a DNS-rebinding guard that runs BEFORE any auth, rejecting unexpected `Origin` values per the MCP security spec; explicitly handle the no-Origin server-to-server case.
**Files (NO shared package — duplicate the file 3×):**
- `services/memory-mcp/src/origin.ts` (create), `services/memory-mcp/src/server.ts` (modify), `services/memory-mcp/src/config.ts` (modify).
- `services/codebase-mcp/src/origin.ts` (create), `services/codebase-mcp/src/server.ts` (modify), `services/codebase-mcp/src/config.ts` (modify).
- `services/secrets-mcp/src/origin.ts` (create), `services/secrets-mcp/src/server.ts` (modify), `services/secrets-mcp/src/config.ts` (modify) — defensive; secrets-mcp stays loopback-only but gets the guard too.
**Pattern:** `services/memory-mcp/src/auth.ts` (the existing Express middleware shape: `(req, res, next)`), mounted in `server.ts` with `app.use(...)`.
**Details:**
- New `origin.ts` exports `originGuard(req, res, next)`:
  - Read `config.allowedOrigins: string[]` (from `ALLOWED_ORIGINS` env, comma-split, trimmed) — add this to each `config.ts`.
  - If `req.headers.origin` is present: allow ONLY if it exactly matches an entry in `allowedOrigins`; else `res.status(403).json({ error: 'origin_not_allowed' })` and return.
  - If `req.headers.origin` is ABSENT (server-to-server / non-browser MCP client — Anthropic's cloud, mcp-remote, Claude Code): **do not silently skip into a wildcard.** Allow it ONLY because the request still must pass the downstream auth/OAuth gate; add a code comment that this branch is intentionally permitted and security rests on auth, not Origin. (Do NOT 403 no-Origin — that would break legitimate non-browser clients including Claude Code over loopback.)
  - For `secrets-mcp`, `ALLOWED_ORIGINS` can be empty → with empty allowlist, any present Origin is rejected, no-Origin loopback passes. Document this.
- Mount in each `server.ts`: `app.get('/healthz', …)` stays first (unauthenticated, no origin check), then `app.use(originGuard)` BEFORE `app.use(requireBearer)`.
- Update each `config.ts`: add `allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '').split(',').map(s=>s.trim()).filter(Boolean)`.
**Depends on:** Step 4 (env keys)
**Verify:**
- `curl -s -o /dev/null -w '%{http_code}' -H 'Origin: https://evil.example' http://127.0.0.1:8080/mcp -d '{}'` → `403`.
- `curl ... -H 'Origin: https://memory.${DOMAIN}' ...` → passes origin guard (then hits auth → 401, expected).
- `curl ...` with NO Origin (Claude Code style) → passes origin guard (then auth). **(AC-002 not broken, AC-003)**
**Gotcha:** Order is critical: `/healthz` must stay above the guard (health checks send no Origin and must always 200). The no-Origin branch MUST be an explicit allow with a comment, not a fallthrough — reviewers will flag a silent skip. This is a **3× duplicated edit**; keep the three `origin.ts` files byte-identical except for any service-specific allowlist defaults.

---

### PHASE 1 — Approach 2 probe: Cloudflare Access "Managed OAuth" (time-boxed GATE)

> **This is a gate, not a build.** If the probe passes the 4-case matrix you ship CF Access and **SKIP Phase 2 entirely** (note the branch in README). If it fails any matrix case, STOP and proceed to Phase 2.

### Step 7: Enable Cloudflare Access Managed OAuth on the two hostnames
<!-- <task id="7" status="pending" file="docs/Deployment/Cloudflare-Access.md" action="create" depends="3,6" /> -->
**What:** Turn on Cloudflare Access with **Managed OAuth** (CF documents this for MCP/non-browser agents: it publishes RFC 8414/9728 metadata, answers `401 WWW-Authenticate`, mints opaque tokens, supports dynamic-client redirect URIs, and injects `Cf-Access-Jwt-Assertion` to the origin).
**Files:** `docs/Deployment/Cloudflare-Access.md` (create — runbook), Cloudflare dashboard config (out-of-band).
**Pattern:** N/A (Cloudflare config). Verify the exact Managed-OAuth toggle + claims via the Cloudflare docs (Context7/`find-docs` "Cloudflare Access MCP managed OAuth") before executing — CF's MCP-auth surface is new and changing.
**Details:**
- Create an Access application for `memory.${DOMAIN}` and one for `codebase.${DOMAIN}` (or one app covering both hostnames).
- Enable **Managed OAuth** (the MCP-server option), NOT a generic self-hosted app with an HTML login.
- Register BOTH redirect URIs on the app: `https://claude.ai/api/mcp/auth_callback` AND `https://claude.com/api/mcp/auth_callback`. **(AC-006)**
- Capture `CF_ACCESS_TEAM_DOMAIN` and the app `CF_ACCESS_AUD` into `.env` (keys added in Step 4).
- **Do NOT also run an origin-level `WWW-Authenticate` 401 at the same time** — CF warns Managed OAuth masks the origin 401, producing a confusing double-challenge. So in this branch, memory/codebase keep `requireBearer` returning 401 for the LOOPBACK path only; the public path is fronted entirely by CF Access (the origin trusts the injected JWT — Step 8).
**Depends on:** Steps 3, 6
**Verify:** `curl -s -i https://memory.${DOMAIN}/.well-known/oauth-protected-resource` (or `/oauth-authorization-server`) returns CF-served metadata JSON; an unauthenticated `curl -i https://memory.${DOMAIN}/mcp` returns `401` with `WWW-Authenticate`. **(AC-001 via CF)**
**Gotcha:** Managed OAuth for MCP is a recent CF feature with a specific toggle; if the dashboard only offers classic self-hosted Access (interactive browser login, no DCR), that is an **immediate probe FAIL** → go to Phase 2.

### Step 8: Origin validates `Cf-Access-Jwt-Assertion` on the public path (2× edit)
<!-- <task id="8" status="pending" file="services/memory-mcp/src/auth.ts" action="modify" depends="7" /> -->
**What:** On public requests (arriving via cloudflared), verify the `Cf-Access-Jwt-Assertion` header against CF Access's public keys (team domain JWKS + expected AUD). Keep static `MNEMO_TOKEN` for the loopback path.
**Files (2×):** `services/memory-mcp/src/auth.ts` + `config.ts`, `services/codebase-mcp/src/auth.ts` + `config.ts`. (secrets-mcp NOT touched — no public path.)
**Pattern:** Existing `requireBearer` in `services/memory-mcp/src/auth.ts` — extend it; populate the SAME `MnemoAuth` shape on success.
**Details:**
- Add config: `cfAccessTeamDomain`, `cfAccessAud` (from env, Step 4).
- In the auth middleware: if `req.headers['cf-access-jwt-assertion']` is present → verify the JWT (issuer `https://${team}.cloudflareaccess.com`, audience = AUD, signature via the team JWKS at `https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`, cache JWKS). On success populate `MnemoAuth { token: '<sub>', clientId: 'cf-access', scopes: ['memory'|'codebase'], extra: { projectId: config.defaultProjectId } }`. **(AC-007)** On failure → `401`.
- If the header is ABSENT → fall back to the existing `MNEMO_TOKEN` static check (this is the loopback/Claude Code path). **(AC-002)**
- Use a small JWT/JWKS verify dependency (`jose`) — add to each `package.json` (2×).
**Depends on:** Step 7
**Verify:** Public request through CF with a valid Access session → tool list loads; a forged `Cf-Access-Jwt-Assertion` → 401; loopback `curl -H "Authorization: Bearer $MNEMO_TOKEN" http://127.0.0.1:8080/mcp` → still works. **(AC-002, AC-007)**
**Gotcha:** `Cf-Access-Jwt-Assertion` is set by CF on the origin request; ensure cloudflared/CF is NOT configured to strip it. Verify AUD matches the specific app, not the account.

### Step 9: PROBE GATE — add the connector in a real client and run the 4-case matrix
<!-- <task id="9" status="pending" file="docs/Deployment/Cloudflare-Access.md" action="docs" depends="8" /> -->
**What:** The explicit pass/fail decision point. Add the connector in Claude Desktop / claude.ai and verify all four cases.
**Files:** `docs/Deployment/Cloudflare-Access.md` (append the matrix + result).
**The 4-case matrix (ALL must pass to ship CF Access):**
1. **PKCE-S256-as-public-client** — Claude registers as a public client (`token_endpoint_auth_method: none`) and the PKCE S256 challenge/verifier round-trips successfully against CF Access.
2. **DCR-with-Anthropic** — CF Access dynamic client registration accepts Anthropic's client and the dynamically supplied `redirect_uris` (the `claude.ai`/`claude.com` callbacks).
3. **Claude-UI-completes-against-CF-Access** — the Claude desktop/web "Add custom connector" flow completes the browser auth against CF Access end-to-end (no dead-end, no infinite redirect).
4. **Token persistence (AC-008)** — first connect → tools load → full Cmd-Q restart → tools still load → token expiry → silent refresh.
**Decision:**
- **PASS (all 4)** → ship CF Access. Mark Phase 2 steps `status="skipped"`. Update README Stage 0/1/2. Skip to Phase 3 (Steps 18–22, which apply to both paths).
- **FAIL (any of 1–4)** → STOP. Record which case failed in the runbook. Proceed to Phase 2 (Step 10+).
**Depends on:** Step 8
**Verify:** This step's "verify" IS the matrix. Record concrete evidence (screenshots/log lines) per case in the runbook.
**Gotcha:** Token persistence across a full Cmd-Q restart is the historical failure mode (claude-code #52565: "tools never load / token lost on restart"). If CF Access stores nothing client-durable and Claude drops the token on restart, that's a FAIL even if 1–3 pass.

---

### PHASE 2 — Approach 1 build: self-hosted OAuth 2.1 AS (`mnemo-auth`) — CONDITIONAL on Step 9 FAIL

> Build ONLY if Step 9 failed. The dependable target. Adds a minimal OAuth 2.1 Authorization Server as a new container, a Postgres-backed token store, a third cloudflared ingress hostname, and swaps the public-path auth on memory/codebase to validate AS-issued tokens.

### Step 10: Postgres token-store schema (init SQL + migration)
<!-- <task id="10" status="pending" file="services/mnemo-auth/sql/001_oauth.sql" action="create" depends="1" /> -->
**What:** A durable, Postgres-backed OAuth store — clients (DCR), authorization codes (+ PKCE), access tokens (~10 min), refresh grants (durable). In-memory would FAIL AC-008 case 3 (restart). **(AC-008)**
**File:** `services/mnemo-auth/sql/001_oauth.sql` (create). Also add a one-line schema bootstrap to `postgres/init/` is NOT needed (init only runs on fresh clusters; the box's cluster exists) — instead apply via a `make oauth-db` target (Makefile, Step 16) like the existing `langfuse-db` idempotent pattern.
**Pattern:** `postgres/init/01-init.sql` (`CREATE SCHEMA IF NOT EXISTS`), `services/secrets-mcp/sql/001_secrets.sql` (table DDL style), and the Makefile `langfuse-db` idempotent creator.
**Details:**
- `CREATE SCHEMA IF NOT EXISTS oauth;`
- `oauth.clients` (client_id PK, client_secret NULL for public clients, redirect_uris text[], token_endpoint_auth_method, created_at). Seed/allow both `https://claude.ai/api/mcp/auth_callback` and `https://claude.com/api/mcp/auth_callback`. **(AC-006)**
- `oauth.auth_codes` (code PK, client_id, redirect_uri, code_challenge, code_challenge_method ('S256'), scope, subject, expires_at ~60s, consumed bool).
- `oauth.access_tokens` (token PK or jti, client_id, subject, scope, project_id, expires_at ~10min). Or issue self-contained JWTs and store only refresh — but per AC-008 the validation must survive restart; a JWKS-signed JWT (Step 12) + a DB-backed refresh table is the cleanest.
- `oauth.refresh_tokens` (token PK, client_id, subject, scope, project_id, expires_at durable, revoked bool, rotated_to).
**Depends on:** Step 1
**Verify:** `make oauth-db` (Step 16) creates the schema idempotently; `\dn` shows `oauth`; re-running is a no-op.
**Gotcha:** Postgres `init/` scripts do NOT run on the existing cluster — use the Makefile idempotent-apply pattern, mirroring `langfuse-db`.

### Step 11: `mnemo-auth` service scaffold (Dockerfile, package.json, tsconfig, pool)
<!-- <task id="11" status="pending" file="services/mnemo-auth/package.json" action="create" depends="10" /> -->
**What:** New Node/Express service skeleton matching the repo conventions.
**Files:** `services/mnemo-auth/Dockerfile`, `services/mnemo-auth/package.json`, `services/mnemo-auth/tsconfig.json`, `services/mnemo-auth/src/config.ts`, `services/mnemo-auth/src/db/pool.ts`, `services/mnemo-auth/src/storage.ts` (all create).
**Pattern:** Copy structure from `services/memory-mcp/` (Dockerfile multi-stage node:22-slim, package.json ESM + tsc build, `src/db/pool.ts` pg.Pool).
**Details:**
- `package.json`: deps `express@^5`, `pg@^8`, `jose` (JWT/JWKS sign+verify), `zod`. ESM, `"type":"module"`, build = `tsc`.
- `config.ts`: `databaseUrl`, `issuer` (`MNEMO_OAUTH_ISSUER=https://auth.${DOMAIN}`), `port` (e.g. 8083), `oauthSchema`, token TTLs (access 600s, refresh durable).
- `storage.ts`: CRUD over the `oauth.*` tables via `pool` (createClient/getClient, putAuthCode/consumeAuthCode, putRefresh/rotateRefresh/revoke). Postgres-backed (AC-008).
- `db/pool.ts`: identical to `services/memory-mcp/src/db/pool.ts`.
**Depends on:** Step 10
**Verify:** `docker compose build mnemo-auth` succeeds (after Step 13 wires it into compose). `tsc` clean.
**Gotcha:** Reuse the EXACT Dockerfile multi-stage shape (build → runtime, `USER node`) so the image is consistent with the other services.

### Step 12: JWKS signing keys + AS endpoints (`src/keys.ts`, `src/server.ts`)
<!-- <task id="12" status="pending" file="services/mnemo-auth/src/server.ts" action="create" depends="11" /> -->
**What:** Implement the minimal OAuth 2.1 AS surface.
**Files:** `services/mnemo-auth/src/keys.ts` (create), `services/mnemo-auth/src/server.ts` (create).
**Pattern:** `@modelcontextprotocol/sdk@1.29.0` `mcpAuthRouter` / `ProxyOAuthServerProvider` if its shape fits; otherwise hand-rolled Express routes. **Confirm the SDK 1.29.0 auth-router export + provider interface via Context7 (`find-docs "@modelcontextprotocol/sdk mcpAuthRouter OAuthServerProvider 1.29"`) before coding** — the API differs across minors.
**Details — endpoints:**
- `GET /.well-known/oauth-authorization-server` (RFC 8414): advertise `issuer`, `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `jwks_uri`, `code_challenge_methods_supported: ["S256"]`, `grant_types_supported: ["authorization_code","refresh_token"]`, `token_endpoint_auth_methods_supported: ["none"]`.
- `GET /.well-known/jwks.json`: public signing key(s) from `keys.ts` (ES256 or RS256 keypair generated once, persisted — store the private key in the secrets-mcp store or a mounted file; NOT in git).
- `POST /register` (RFC 7591 DCR): accept JSON `{ redirect_uris, token_endpoint_auth_method: "none", ... }`, validate redirect URIs are among the allowed set (claude.ai + claude.com callbacks), persist via `storage.createClient`, return `client_id` (+ no secret for public client). **(AC-006)**
- `GET /authorize` (PKCE S256): validate `client_id`, `redirect_uri`, `code_challenge`, `code_challenge_method=S256`; render a minimal login/consent (single shared password or allow-by-default for the solo operator — keep it minimal but real); on approve, issue an auth code bound to the PKCE challenge; redirect to `redirect_uri?code=...&state=...`.
- `POST /token` (`application/x-www-form-urlencoded`): `grant_type=authorization_code` (verify PKCE verifier vs stored challenge, one-time code) → issue JWT access token (~10min, signed by JWKS key, claims include `sub`, `scope`, `aud`=resource, a `projectId` claim = `DEFAULT_PROJECT_ID`) + a refresh token (durable, stored). `grant_type=refresh_token` → rotate refresh, mint new access. **(AC-008 case 4)**
**Depends on:** Step 11
**Verify:** `curl https://auth.${DOMAIN}/.well-known/oauth-authorization-server` returns valid metadata; a scripted PKCE round-trip (register → authorize → token) yields a JWT verifiable against `/.well-known/jwks.json`.
**Gotcha:** PKCE S256 verifier check must be constant-time and one-shot (consume the code). Persist the signing keypair (a fresh key each boot invalidates all live tokens → AC-008 fail on restart). `/token` MUST accept form-encoded, not JSON.

### Step 13: Wire `mnemo-auth` into compose + add `auth.${DOMAIN}` ingress
<!-- <task id="13" status="pending" file="/opt/mnemosyne/compose.yaml" action="modify" depends="12,3" /> -->
**What:** Add the AS container and a third cloudflared ingress hostname.
**Files:** `/opt/mnemosyne/compose.yaml` (modify), `/opt/mnemosyne/cloudflared/config.yml` (modify).
**Pattern:** memory-mcp service block; existing ingress list.
**Details:**
- compose `mnemo-auth` service: build `./services/mnemo-auth`, env `DATABASE_URL`, `MNEMO_OAUTH_ISSUER`, `PORT=8083`, signing-key mount or secret; `networks: [backend, edge]` (backend=Postgres token store, edge=cloudflared ingress); `ports: ["127.0.0.1:8083:8083"]` (loopback for debugging); `depends_on: postgres healthy`; healthcheck on `/.well-known/oauth-authorization-server`.
- cloudflared `config.yml`: insert BEFORE the catch-all:
  ```yaml
    - hostname: auth.${DOMAIN}
      service: http://mnemo-auth:8083
  ```
  Still NO secrets-mcp route.
**Depends on:** Steps 12, 3
**Verify:** `docker compose up -d --build mnemo-auth cloudflared`; `curl https://auth.${DOMAIN}/.well-known/oauth-authorization-server` returns metadata through the tunnel. `docker compose exec cloudflared wget -qO- http://secrets-mcp:8082/healthz` still UNREACHABLE. **(AC-004 holds)**
**Gotcha:** mnemo-auth on `edge` is fine (it's a public-facing AS); it must NOT be on secrets-mcp's `loopback` net.

### Step 14: PRM + 401 WWW-Authenticate + AS-token verification on memory/codebase (2× edit) — with the loopback BYPASS
<!-- <task id="14" status="pending" file="services/memory-mcp/src/auth.ts" action="modify" depends="13" /> -->
**What:** Make the two public MCP servers OAuth resource servers: advertise PRM, answer unauth `/mcp` with 401→PRM, and validate AS-issued tokens on the PUBLIC path — while LOOPBACK requests bypass OAuth and keep the existing static bearer. **This is the single subtle correctness risk; the bypass predicate must be source-based, not header-based.**
**Files (2×):** `services/memory-mcp/src/auth.ts` + `config.ts` + `server.ts`; `services/codebase-mcp/src/auth.ts` + `config.ts` + `server.ts`. (secrets-mcp untouched — no public path.) Add `jose` to both `package.json`.
**Pattern:** SDK 1.29.0 `mcpAuthRouter` + `requireBearerAuth` + a `TokenVerifier`; existing `requireBearer` for the inner gate. **Verify SDK exports via Context7 first.**
**Details:**
- **OAuth = OUTER middleware; existing `requireBearer` = INNER gate.** Architecture: `originGuard` → `publicOrLoopbackAuth` → (`/mcp` handler). `publicOrLoopbackAuth` branches on SOURCE:
  - **Loopback path** (request came from the host-gateway loopback publish, i.e. Claude Code / mcp-remote over `127.0.0.1:8080`): take the BYPASS → run the existing static `requireBearer` (`MNEMO_TOKEN`) and skip OAuth. **(AC-002)**
  - **Public path** (request came from the cloudflared container on the `edge` network): require OAuth — validate the AS-issued JWT (verify against `https://auth.${DOMAIN}/.well-known/jwks.json`, issuer, audience), then populate `MnemoAuth` from the token claims (`extra.projectId` from the `projectId` claim or default). **(AC-007)**
- **BYPASS PREDICATE — computed from the connection source, NEVER a spoofable header:**
  - Both public and loopback requests hit the same `0.0.0.0:8080` listener (verified). Distinguish by `req.socket.remoteAddress`:
    - Loopback publish via Docker appears as the **host-gateway / bridge gateway IP** (the docker-proxy/userland-proxy source — typically the `backend`/default bridge gateway, e.g. `172.x.0.1`, or `127.0.0.1` depending on userland-proxy). cloudflared appears as **its `edge`-network container IP** (e.g. `172.19.0.x`).
    - **Robust implementation:** resolve cloudflared's `edge` IP at startup (DNS-lookup `cloudflared` on the edge net, or read the edge subnet CIDR) and treat requests whose `remoteAddress` is in the `edge` subnet as PUBLIC (must pass OAuth); ALL other sources (loopback publish) are LOOPBACK. Equivalently: bind a SEPARATE internal listener — but the code binds one `0.0.0.0` listener, so source-IP discrimination is the chosen mechanism.
    - **NEVER** key the bypass off `Host`, `X-Forwarded-For`, `X-Forwarded-Host`, or `Origin` — all client-controllable. A public request that spoofs `Host: localhost` must STILL be forced through OAuth. **(AC-009)**
  - Add config: `edgeSubnetCidr` (or `cloudflaredHost`) and `oauthIssuer`/`jwksUri` to each `config.ts`.
- **PRM + 401:** add `GET /.well-known/oauth-protected-resource` (RFC 9728) advertising the resource + its AS (`authorization_servers: ["https://auth.${DOMAIN}"]`); when a PUBLIC `/mcp` request lacks/has-invalid token → `401` with `WWW-Authenticate: Bearer resource_metadata="https://memory.${DOMAIN}/.well-known/oauth-protected-resource"`. Use the SDK's `getOAuthProtectedResourceMetadataUrl` helper if present. **(AC-001)**
**Depends on:** Step 13
**Verify (the security-critical tests):**
1. Public unauth: `curl -i https://memory.${DOMAIN}/mcp -d '{}'` → `401` + `WWW-Authenticate` pointing at PRM. **(AC-001)**
2. Loopback unchanged: `curl -H "Authorization: Bearer $MNEMO_TOKEN" http://127.0.0.1:8080/mcp ...` → works. **(AC-002)**
3. **Bypass cannot be spoofed:** `curl -i https://memory.${DOMAIN}/mcp -H 'Host: localhost' -H 'X-Forwarded-For: 127.0.0.1' -d '{}'` → STILL `401` (OAuth enforced; source is the edge subnet). **(AC-009)**
4. Valid AS token through CF → tool list loads, `extra.projectId` populated. **(AC-007)**
**Gotcha:** Determine empirically (on the box, with the stack up) what `req.socket.remoteAddress` actually is for (a) a loopback `curl 127.0.0.1:8080` and (b) a cloudflared-proxied request — Docker's userland-proxy may rewrite the loopback source to the bridge gateway. Pin the predicate to the **edge subnet** (public) and default everything else to loopback, so a misclassification fails CLOSED toward "treat as loopback only if NOT from edge" — but verify edge detection is positive (an unknown source must NOT silently get the bypass; if edge detection is uncertain, require OAuth). Re-confirm `enableJsonResponse:true` + `sessionIdGenerator:undefined` survive (AC-011).

### Step 15: Persist the AS signing keypair + register Anthropic redirect URIs
<!-- <task id="15" status="pending" file="services/mnemo-auth/src/keys.ts" action="modify" depends="12" /> -->
**What:** Ensure the signing keypair is durable (survives container restart) and the allowed redirect-URI set includes both Anthropic callbacks.
**Files:** `services/mnemo-auth/src/keys.ts` (modify), `services/mnemo-auth/sql/001_oauth.sql` or a key file mount.
**Pattern:** secrets-mcp's pgcrypto-at-rest pattern (store the private JWK encrypted in Postgres) OR a gitignored mounted key file under `./cloudflared`-style out-of-band dir.
**Details:**
- On boot: if a signing key exists (DB row or mounted file) load it; else generate ES256/RS256 once and persist. Never regenerate on restart (AC-008 case 4 depends on stable keys for refresh-minted tokens).
- The DCR allowlist (Step 12 `/register`) accepts ONLY redirect URIs whose origin is `https://claude.ai` or `https://claude.com` with path `/api/mcp/auth_callback`. **(AC-006)**
**Depends on:** Step 12
**Verify:** Restart `mnemo-auth`; a token minted before restart still verifies against the unchanged JWKS; refresh works after restart.
**Gotcha:** If the key lives in a mounted file, add it to `.gitignore` (Step 1) — it's signing material.

### Step 16: Makefile + systemd glue for the new services
<!-- <task id="16" status="pending" file="/opt/mnemosyne/Makefile" action="modify" depends="10,13" /> -->
**What:** Add idempotent ops targets and confirm systemd brings the new containers up.
**Files:** `/opt/mnemosyne/Makefile` (modify). systemd unit needs NO change (it runs `docker compose up -d --remove-orphans`, which picks up new services).
**Pattern:** Existing `langfuse-db` idempotent creator + `up`/`down`/`verify` targets.
**Details:**
- `oauth-db`: idempotently create the `oauth` schema (apply `services/mnemo-auth/sql/001_oauth.sql`) on the existing cluster, mirroring `langfuse-db`.
- Add `mnemo-auth`/`cloudflared` to any "bring up everything" target; keep `up` (postgres+redis) as-is.
- Document the apply flow: `docker compose up -d --build` then `sudo systemctl restart mnemosyne` (oneshot re-converges). **No `--no-verify`.**
**Depends on:** Steps 10, 13
**Verify:** `make oauth-db` twice → second run is a no-op; `sudo systemctl restart mnemosyne && docker compose ps` shows cloudflared + mnemo-auth healthy.
**Gotcha:** systemd is `Type=oneshot RemainAfterExit=yes` — `systemctl restart` re-runs `docker compose up -d` which rebuilds nothing (build happens via the explicit `--build`). Always `--build` first, then restart.

---

### PHASE 3 — Desktop fallback + verification + docs (applies to WHICHEVER auth path shipped)

### Step 17: Document the `mcp-remote` stdio bridge for Claude Desktop
<!-- <task id="17" status="pending" file="docs/Deployment/Cloudflare-Tunnel.md" action="create" depends="9" /> -->
**What:** Desktop-only fallback for clients that can't speak remote OAuth Streamable HTTP directly — and the only way to expose secrets-mcp (Desktop-only, never public).
**Files:** `docs/Deployment/Cloudflare-Tunnel.md` (create) + a `claude_desktop_config.json` snippet block.
**Pattern:** Standard `mcp-remote` invocation. Verify current `mcp-remote` flags via `find-docs`/npm before locking.
**Details:**
- `claude_desktop_config.json` entries for memory + codebase (public hostnames via OAuth) AND secrets (local `http://127.0.0.1:8082/mcp`, Desktop-only):
  ```json
  {
    "mcpServers": {
      "mnemo-memory": {
        "command": "npx",
        "args": ["-y", "mcp-remote@0.1.16", "https://memory.${DOMAIN}/mcp", "--transport", "http-only"]
      },
      "mnemo-secrets": {
        "command": "npx",
        "args": ["-y", "mcp-remote@0.1.16", "http://127.0.0.1:8082/mcp", "--transport", "http-only",
                 "--header", "Authorization:Bearer ${AUTH_HEADER}"],
        "env": { "AUTH_HEADER": "<MNEMO_TOKEN>" }
      }
    }
  }
  ```
- **Pin `mcp-remote >= 0.1.16`** (CVE-2025-6514 RCE affects 0.0.5–0.1.15). **(AC-012)**
- `--transport http-only` (the stack has NO SSE half).
- `--header Authorization:Bearer ${AUTH_HEADER}` — NO space around the colon; value via env var (mcp-remote quirk). **(AC-012)**
- State explicitly: this bridge does NOT help Cowork or claude.ai (those need the native remote connector); it's Desktop-only. secrets-mcp is reachable ONLY here (loopback), never public.
**Depends on:** Step 9 (path decided)
**Verify:** On a Desktop machine with an SSH tunnel/loopback to the box, the bridge connects; secrets-mcp tools appear in Desktop only.
**Gotcha:** The space-after-colon bug silently drops the header → 401. Pin the exact version; `@latest` re-introduces drift/CVE risk.

### Step 18: Confirm Claude Code localhost path is untouched
<!-- <task id="18" status="pending" file="docs/Deployment/Cloudflare-Tunnel.md" action="docs" depends="6,14" /> -->
**What:** Explicit regression note + check that the existing `http://localhost:8080-8082/mcp` Claude Code config still works unchanged.
**Files:** `docs/Deployment/Cloudflare-Tunnel.md` (append a "Claude Code (unchanged)" section).
**Pattern:** N/A.
**Details:**
- Document that Claude Code connects FROM the host machine over loopback (not Anthropic cloud), takes the loopback path (static `MNEMO_TOKEN` or open), and is unaffected by the public OAuth additions.
- This is the regression backstop for AC-002.
**Depends on:** Steps 6, 14
**Verify:** With the full stack up, run the existing Claude Code MCP config against all three localhost ports → tools load for memory, codebase, AND secrets (loopback) exactly as before. **(AC-002, AC-005)**
**Gotcha:** The Origin guard (Step 6) must NOT break no-Origin loopback Claude Code requests — re-test after Step 6 lands, not just at the end.

### Step 19: TOKEN-PERSISTENCE GATE (hard acceptance — applies to shipped path)
<!-- <task id="19" status="pending" file="docs/Deployment/Cloudflare-Tunnel.md" action="docs" depends="9,14" /> -->
**What:** Run the 4-case persistence matrix against whichever path shipped (CF Access OR mnemo-auth).
**Files:** record results in the relevant runbook.
**The 4 cases (ALL must pass):**
1. First connect succeeds.
2. Tool list loads.
3. Full Claude Desktop restart (Cmd-Q + relaunch) → tools STILL load (no re-auth). ← in-memory store fails here; this is why mnemo-auth is Postgres-backed.
4. Access-token expiry → silent refresh works. **(AC-008)**
**Depends on:** Steps 9, 14
**Verify:** All four observed; if case 3 or 4 fails on CF Access, that retroactively forces Phase 2; if it fails on mnemo-auth, the token store / refresh is broken — fix before sign-off.
**Gotcha:** Case 3 is the classic regression (claude-code #52565). Test it deliberately, not by assumption.

### Step 20: Stateless-transport / header-preservation invariant check
<!-- <task id="20" status="pending" file="" action="test" depends="14" /> -->
**What:** Verify cloudflared (+ any proxy) preserves the MCP-critical headers + POST body and that no sticky session is required.
**Files:** N/A (curl-based verification, recorded in runbook).
**Scenarios:**
- A `POST https://memory.${DOMAIN}/mcp` with `Authorization`, `Accept: application/json, text/event-stream`, `MCP-Protocol-Version`, `Origin` → all arrive intact at the origin (log them at the origin temporarily, or assert via a successful tool call). **(AC-011)**
- Two sequential requests land on the stateless transport with no session affinity needed (`sessionIdGenerator: undefined`, `enableJsonResponse: true` confirmed in code).
**Depends on:** Step 14 (or Step 8 in the CF-Access branch)
**Verify:** Tool calls succeed repeatedly without a session cookie; headers present in origin logs.
**Gotcha:** If a future Cloudflare WAF/transform rule strips `Authorization` or the protocol-version header, the connector silently breaks — note this in the runbook as a thing to check if it regresses.

### Step 21: End-to-end connector verification across all three clients
<!-- <task id="21" status="pending" file="" action="test" depends="17,18,19,20" /> -->
**What:** The user-visible outcome check.
**Files:** N/A (manual matrix, recorded in runbook).
**Scenarios:**
- **claude.ai (web):** add `https://memory.${DOMAIN}/mcp` + `https://codebase.${DOMAIN}/mcp` as custom connectors → OAuth completes → tools load and a sample `memory_search` / `code_search` returns results.
- **Claude Desktop:** native remote connector for memory+codebase; `mcp-remote` bridge for secrets (loopback).
- **Cowork:** add the two public connectors → OAuth → tools load.
- **Negative:** attempt to add `https://secrets.${DOMAIN}/mcp` → DNS/ingress 404 (no route). secrets reachable ONLY via the Desktop loopback bridge. **(AC-004)**
**Depends on:** Steps 17–20
**Verify:** All three clients list memory+codebase tools and execute one tool each; secrets has no public route.
**Gotcha:** claude.ai and claude.com are distinct callback origins — both must be registered (AC-006) or one client family fails at the redirect.

### Step 22: Documentation + ADR + README stage checkboxes
<!-- <task id="22" status="pending" file="docs/ArchitecturalDecisions/MCP-OAuth.md" action="docs" depends="9,21" /> -->
**What:** Write the runbooks + ADR + flip README stages.
**Files:**
- `docs/Deployment/Cloudflare-Tunnel.md` — tunnel setup, ingress (incl. the deliberate absence of a secrets route), apply flow (`docker compose up -d --build` + `systemctl restart mnemosyne`), mcp-remote bridge, Claude Code-unchanged note.
- `docs/Deployment/Cloudflare-Access.md` — Managed-OAuth probe runbook + the 4-case matrix + connector registration (both redirect URIs) + the PASS/FAIL decision recorded.
- `docs/ArchitecturalDecisions/MCP-OAuth.md` — **only if Phase 2 shipped**: the self-hosted AS design (endpoints, Postgres token store, JWKS, the source-based loopback bypass + why not header-based, the outer-OAuth/inner-bearer layering).
- `README.md` — update the Layout block (add `cloudflared/`, `docs/`, `services/mnemo-auth/` if built), check `[x] Stage 0: cloudflare tunnel`, and add the new "remote connector" line under Stages.
**Depends on:** Steps 9, 21
**Verify:** Docs match the shipped reality (which path, which hostnames, which steps were skipped). README stages reflect actual state.
**Gotcha:** If Phase 2 was skipped (CF Access passed), do NOT write the MCP-OAuth ADR as if mnemo-auth exists — document the CF Access decision instead and mark Phase 2 steps skipped.

---

## Goal-Backward Verification

**End state:** "A user can add `https://memory.${DOMAIN}/mcp` and `https://codebase.${DOMAIN}/mcp` as OAuth-protected custom connectors in claude.ai / Cowork / Claude Desktop, complete auth, and run memory/codebase tools — while secrets-mcp is unreachable publicly and Claude Code over localhost still works unchanged."

Tracing backward:
- **Client lists tools** → connector registered (Step 21) → OAuth completes (Step 9 CF-Access OR Steps 12+14 mnemo-auth) → 401→PRM→AS metadata advertised (Step 8 OR Step 14) ✓
- **Tool runs with right project** → `MnemoAuth.extra.projectId` populated on the public path (Step 8 OR Step 14, AC-007) ✓
- **Request reaches the origin** → cloudflared ingress routes memory/codebase (Step 3) → reaches container over `edge` (Step 5 left them on edge) ✓
- **Public request is gated** → Origin guard (Step 6) → OAuth outer (Step 8/14) → inner bearer/loopback bypass (Step 14) ✓
- **secrets never public** → no ingress route (Step 3) + off the cloudflared net (Step 5) + verified unreachable from cloudflared (Steps 5,13 verify) ✓
- **Claude Code unchanged** → loopback bypass + no-Origin allowed (Steps 6,14,18, AC-002) ✓
- **Survives restart** → Postgres token store + persisted JWKS (Steps 10,11,15, AC-008) ✓
- **Nothing leaks to git** → gitignore + pre-commit (Steps 1,2, AC-010) ✓

**[ADDED BY BACKWARD CHECK]** Step 15 (persist signing keypair) and Step 18 (explicit Claude Code regression check) and Step 20 (header-preservation) were added because forward planning under-specified: (a) restart-stable signing keys are required for refresh to survive restart, (b) the Origin guard could silently break no-Origin loopback Claude Code, and (c) a future WAF/transform could strip `Authorization`. No remaining AC is without an owning step.

---

## Risks

- **Bypass misclassification (highest):** if the source-based public/loopback predicate (Step 14) is wrong, either Claude Code breaks (loopback misread as public) or — worse — a public request gets the OAuth bypass (AC-009 violation). Mitigate: determine `req.socket.remoteAddress` empirically with the stack up for BOTH paths before finalizing; fail closed (unknown source → require OAuth); add the spoofed-`Host` test (Step 14 verify #3) to the gate.
- **Docker userland-proxy source rewriting:** the loopback publish may present as the bridge gateway IP, not `127.0.0.1`. The predicate must key off the **edge subnet = public**, treating all else as loopback — verify the actual edge subnet CIDR at runtime.
- **CF Managed OAuth immaturity (probe):** the feature is new; the dashboard may only offer classic interactive Access (no DCR/PKCE-public-client) → probe FAIL → Phase 2. Time-box the probe; don't sink days into CF if matrix case 1/2/3 fails fast.
- **Token loss on restart:** in-memory store = AC-008 case-3 fail (claude-code #52565). Postgres-backed store + persisted JWKS mitigates; explicitly tested in Step 19.
- **`mcp-remote` CVE / colon-space bug:** pin >=0.1.16 and no space after `Authorization:` (Step 17).
- **Accidental secret commit:** new repo will carry tunnel/OAuth material; mitigated by Steps 1–2, but the FIRST `git add -A` is the dangerous moment — verify ignores before it.
- **SDK auth API drift:** `@modelcontextprotocol/sdk@1.29.0` auth-router/provider exports differ across minors; confirm via Context7 before Steps 12/14.
- **systemd oneshot + `--build`:** `systemctl restart mnemosyne` does NOT rebuild; forgetting `docker compose up -d --build` first ships stale images.

## Manual Verification

- [ ] cloudflared logs show 4 healthy edge connections; `docker port` shows no inbound on cloudflared.
- [ ] `curl 127.0.0.1:8082/healthz` works AND `docker compose exec cloudflared wget http://secrets-mcp:8082/healthz` is UNREACHABLE.
- [ ] Public unauth `/mcp` → 401 + WWW-Authenticate→PRM.
- [ ] Spoofed `Host: localhost` + `X-Forwarded-For: 127.0.0.1` on the public URL → STILL 401 (bypass not spoofable).
- [ ] Claude Code over `localhost:8080-8082` → all three load, unchanged.
- [ ] claude.ai + Cowork + Desktop: memory+codebase connectors complete OAuth and run a tool.
- [ ] Token persistence 4-case matrix passes (esp. full Cmd-Q restart).
- [ ] Postgres 5432 + Redis 6379 still loopback-only; backend net still `internal:true`.
- [ ] `git check-ignore .env backups/ cloudflared/<id>.json` all ignored; no secrets in `git log -p`.

## Environment Changes

- [ ] New env (`.env` on box, `.env.example` template): `DOMAIN`, `TUNNEL_TOKEN` or `TUNNEL_ID`, `PUBLIC_ORIGIN`, `ALLOWED_ORIGINS`. CF-Access branch: `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`. mnemo-auth branch: `MNEMO_OAUTH_ISSUER`, `OAUTH_DB_SCHEMA`.
- [ ] New files mounted out-of-band (gitignored): `cloudflared/<TUNNEL_ID>.json`, optional `cloudflared/cert.pem`, optional mnemo-auth signing-key file.
- [ ] New compose services: `cloudflared` (no ports), `mnemo-auth` (loopback 8083) [Phase 2 only].
- [ ] New top-level network: `loopback` (non-internal) for secrets-mcp.
- [ ] New Postgres schema `oauth` (Phase 2 only), applied via `make oauth-db` (idempotent, NOT via init/).
- [ ] New deps: `jose` in memory-mcp + codebase-mcp (CF-Access JWT verify and/or AS-token verify); `jose` + `pg` + `express` + `zod` in mnemo-auth.
- [ ] Apply flow: `docker compose up -d --build [service]` then `sudo systemctl restart mnemosyne`. Never `--no-verify`.
