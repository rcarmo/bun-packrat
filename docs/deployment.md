# Deployment

Packrat can run as one Docker container or as a local Bun process. Docker includes the matching Chromium binaries and runtime libraries.

## Docker

Set an authentication password before starting the service:

```bash
export PACKRAT_AUTH_PASSWORD='replace-with-a-secret'
make up
```

The equivalent commands are:

```bash
docker compose build
mkdir -p data config
docker compose up -d
```

Open <http://localhost:3047/>. The default username is `packrat`.

The first build downloads Chromium and produces an image of about 500 MB. Container startup does not download a browser.

### Volumes

| Host path | Container path | Purpose |
|---|---|---|
| `./data` | `/data` | SQLite database and required persistent data. |
| `./config` | `/config` | Optional read-only `.env` file. |

Create `config/.env` to override container settings:

```dotenv
PACKRAT_BASE_URL=http://packrat.local
PACKRAT_HTML_COMPRESSION=gzip
PACKRAT_MAX_CONCURRENT_CAPTURES=3
PACKRAT_AUTH_USER=packrat
PACKRAT_AUTH_PASSWORD=replace-with-a-secret
```

The entry point reads `/config/.env`. To run with host-matching file ownership, uncomment `PUID` and `PGID` in `docker-compose.yml`; these values must be container environment variables rather than entries in `/config/.env`. The Compose definition allocates 256 MB of shared memory for Chromium.

### Make targets

| Target | Action |
|---|---|
| `make build` | Build the image. |
| `make build-clean` | Rebuild without the Docker cache. |
| `make run` | Start the service. |
| `make up` | Build and start. |
| `make stop` | Stop and remove the container. |
| `make logs` | Follow service logs. |
| `make shell` | Open a shell in the container. |
| `make test` | Run tests on the host. |
| `make clean` | Remove containers, volumes and the local image. |

## Local Bun process

Install dependencies and ensure Playwright can find Chromium:

```bash
bun install
PLAYWRIGHT_BROWSERS_PATH=/workspace/bin/pw-browsers \
PACKRAT_AUTH_DISABLED=1 \
bun run src/server.ts
```

The default database path is `./data/packrat.db`. Migrations run when the database opens.

For an authenticated local service:

```bash
PACKRAT_AUTH_USER=packrat \
PACKRAT_AUTH_PASSWORD='replace-with-a-secret' \
bun run src/server.ts
```

## Health check

```bash
curl -u 'packrat:replace-with-a-secret' \
  http://localhost:3047/api/status
```

An explicitly unauthenticated deployment does not require credentials:

```bash
PACKRAT_AUTH_DISABLED=1 bun run src/server.ts
curl http://localhost:3047/api/status
```

Use unauthenticated mode only on a trusted network.
