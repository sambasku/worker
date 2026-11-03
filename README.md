# worker

Job operasional SambasKu yang dijalankan lewat **GitHub Actions** (manual),
bukan runtime API.

## Sync DB prod → staging

Wipe database staging lalu salin **penuh** dari production (semua tabel,
termasuk data pribadi user). Dest yang diizinkan hanya
`db-sambasku-staging.iamutaki.com`.

### Secrets organisasi

| Peran | Secret |
| --- | --- |
| Source (baca) | `DB_PRODUCTION_TURSO_URL`, `DB_PRODUCTION_TURSO_AUTH_TOKEN` |
| Dest (wipe+tulis) | `DB_STAGING_TURSO_URL`, `DB_STAGING_TURSO_AUTH_TOKEN` |

Pastikan repo `sambasku/worker` punya akses ke secret org tersebut.

### Trigger

GitHub → Actions → **Sync DB Prod → Staging (manual)** → Run workflow →
centang **confirm**.

Atau CLI:

```bash
gh workflow run sync-db-prod-to-staging.yml \
  --repo sambasku/worker \
  --ref main \
  -f confirm=true
```

Tanpa `confirm=true`, job sync di-skip.

### Lokal (opsional)

```bash
cp .env.example .env
# isi SOURCE_* / DEST_*
pnpm install
pnpm sync-prod-staging -- --i-understand-dest-will-be-wiped
```
