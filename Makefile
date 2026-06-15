.PHONY: secrets up down ps logs psql redis-cli verify

# Generate .env with strong random secrets (idempotent — won't clobber existing).
secrets:
	@if [ -f .env ]; then echo ".env already exists — not overwriting"; else \
		printf 'POSTGRES_DB=mnemosyne\nPOSTGRES_USER=mnemo\nPOSTGRES_PASSWORD=%s\nREDIS_PASSWORD=%s\n' \
			"$$(openssl rand -hex 24)" "$$(openssl rand -hex 24)" > .env; \
		chmod 600 .env; echo ".env created (chmod 600)"; fi

up:
	docker compose up -d postgres redis

down:
	docker compose down

ps:
	docker compose ps

logs:
	docker compose logs -f

# psql into the running cluster using .env creds.
psql:
	@set -a; . ./.env; set +a; \
	docker compose exec -e PGPASSWORD=$$POSTGRES_PASSWORD postgres \
		psql -U $$POSTGRES_USER -d $$POSTGRES_DB

redis-cli:
	@set -a; . ./.env; set +a; \
	docker compose exec redis redis-cli -a $$REDIS_PASSWORD

# Verify pgvector + schemas are live.
verify:
	@set -a; . ./.env; set +a; \
	docker compose exec -e PGPASSWORD=$$POSTGRES_PASSWORD postgres \
		psql -U $$POSTGRES_USER -d $$POSTGRES_DB -c \
		"SELECT extname, extversion FROM pg_extension WHERE extname='vector'; \
		 SELECT nspname FROM pg_namespace WHERE nspname IN ('memory','codebase');"
