# Command-line interface

Run the CLI from the repository root:

```bash
bun run src/cli/index.ts <command> [arguments]
```

The CLI opens the database specified by `PACKRAT_DB`, which defaults to `./data/packrat.db`.

## Commands

| Command | Action |
|---|---|
| `capture <url> [--force]` | Capture a URL synchronously. `--force` bypasses freshness reuse. |
| `search <query> [filters]` | Search indexed captures and write JSON. |
| `list [--limit N]` | List recent successful captures. Default: 20. |
| `export <id> --format html\|md\|epub\|pdf [--output path]` | Generate one export. |
| `delete <id> --confirm` | Permanently delete one capture and its dependent data. |
| `backup <destination.sqlite>` | Create a consistent backup with `VACUUM INTO`. |
| `verify [--all] [--id N]` | Run SQLite integrity and capture hash checks. |
| `migrate` | Open the database and apply pending migrations. |
| `status` | Print capture, queue and database statistics. |

## Capture

```bash
bun run src/cli/index.ts capture https://example.com/article
bun run src/cli/index.ts capture https://example.com/article --force
```

The command writes the capture result as JSON. Browser progress and errors go to standard error.

## Search

```bash
bun run src/cli/index.ts search 'sqlite backup' \
  --domain example.com \
  --tag reference \
  --mode full_page \
  --status succeeded \
  --sort relevance \
  --limit 20
```

Available filters are `--domain`, `--tag`, `--mode`, `--status`, `--sort` and `--limit`.

## Export

```bash
bun run src/cli/index.ts export 123 --format epub --output article.epub
```

Supported formats are `html`, `md`, `epub` and `pdf`. The `md` format produces a ZIP file. The command writes to a generated filename unless `--output` supplies another path.

## Delete

```bash
bun run src/cli/index.ts delete 123 --confirm
```

The command does not prompt. It returns JSON and fails unless `--confirm` is present.

## Backup and verify

```bash
bun run src/cli/index.ts backup /path/to/packrat-backup.sqlite
bun run src/cli/index.ts verify --all
bun run src/cli/index.ts verify --id 123
```

`verify --all` checks `PRAGMA integrity_check` and recomputes stored content hashes. Use it after a backup or restore.
