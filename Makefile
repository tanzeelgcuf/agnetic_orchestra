.PHONY: setup dev test lint typecheck e2e db-migrate down clean

setup:
	pnpm install
	docker compose up -d postgres
	pnpm db:migrate

dev:
	docker compose up -d postgres
	pnpm db:migrate
	pnpm --filter api --filter worker --filter web --parallel run dev

test:
	pnpm test

lint:
	pnpm lint

typecheck:
	pnpm typecheck

e2e:
	pnpm test:e2e

db-migrate:
	pnpm db:migrate

down:
	docker compose down

clean:
	docker compose down -v
