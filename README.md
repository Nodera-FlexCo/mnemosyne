# Mnemosyne

Dual-engine memory + codebase search for Claude Code, self-hosted on a Hetzner
EX44. See `mnemosyne-ex44-revision.md` (one level up) for the full architecture.

## Layout

```
compose.yaml            # service stack (data layer now; mcp/indexer/cloudflared later)
postgres/init/          # first-boot SQL (extensions + schemas)
systemd/                # mnemosyne.service — supervises `docker compose` on boot
.env.example            # config template; real .env is generated on the box
```

## Host

- Box: `mnemo` SSH alias → root@157.180.50.51 (Ubuntu 26.04, i5-13500, 125GB, RAID1 NVMe)
- Deploy target: `/opt/mnemosyne` (owned by `development`)

## Common commands (run on the box, in /opt/mnemosyne)

```bash
make secrets     # generate .env with strong random secrets (once)
docker compose up -d postgres redis
docker compose ps
docker compose logs -f postgres
```

## Stages

- [x] Stage 0: host hardening, Docker, data layer
- [ ] Stage 0: cloudflare tunnel (needs domain + token)
- [ ] Stage 1: memory engine
- [ ] Stage 2: codebase engine
- [ ] Stage 3: optimization
