IMAGE   := packrat
TAG     := local
COMPOSE := docker compose

.PHONY: build run stop logs shell test clean

## Build the Docker image
build:
	$(COMPOSE) build

## Build without cache (use after Playwright or dep upgrades)
build-clean:
	$(COMPOSE) build --no-cache

## Start the service in the background
run:
	mkdir -p data config
	$(COMPOSE) up -d

## Stop the service
stop:
	$(COMPOSE) down

## Tail service logs
logs:
	$(COMPOSE) logs -f packrat

## Open a shell inside the running container
shell:
	$(COMPOSE) exec packrat /bin/sh

## Run tests (host, not inside Docker)
test:
	bun test

## Remove image and containers
clean:
	$(COMPOSE) down --rmi local -v --remove-orphans

## One-shot: build then start
up: build run
