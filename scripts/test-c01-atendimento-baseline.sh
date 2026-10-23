#!/usr/bin/env bash
# Bancada explícita P2. Só aceita PG/PostgREST locais e banco c01_p2_*.
# A instalação opcional usa o prelude oficial e o baseline inteiro, sem editar SQL.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
: "${C01_P2_DATABASE_URL:?Informe o PostgreSQL efêmero local}"
: "${C01_P2_POSTGREST_URL:?Informe o PostgREST local}"
: "${C01_P2_JWT_SECRET:?Informe a chave sintética do PostgREST local}"
python3 - <<'PY'
import os, re
from urllib.parse import urlparse
db = urlparse(os.environ['C01_P2_DATABASE_URL'])
rest = urlparse(os.environ['C01_P2_POSTGREST_URL'])
if db.hostname != '127.0.0.1' or rest.hostname != '127.0.0.1':
    raise SystemExit('Recusado: os dois serviços precisam estar em 127.0.0.1')
if db.scheme not in ('postgres', 'postgresql') or db.query or db.fragment:
    raise SystemExit('Recusado: URL PostgreSQL direta, sem parâmetros ou fragmento')
if not re.fullmatch(r'/c01_p2_[a-zA-Z0-9_]+', db.path):
    raise SystemExit('Recusado: use um banco descartável chamado c01_p2_*')
if rest.scheme != 'http' or rest.path not in ('', '/') or rest.query or rest.fragment or rest.username or rest.password:
    raise SystemExit('Recusado: URL HTTP local direta, sem credenciais ou parâmetros')
if len(os.environ['C01_P2_JWT_SECRET']) < 32:
    raise SystemExit('Recusado: a chave sintética precisa de pelo menos 32 caracteres')
PY
if [ "${C01_P2_INSTALL_BASELINE:-0}" = 1 ]; then
  # Extrai SOMENTE o bloco do prelude da receita oficial; não mantém cópia divergente.
  python3 - <<'PY' | psql "$C01_P2_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f -
from pathlib import Path
source = Path('scripts/test-db.sh').read_text()
start = source.index('echo "==> prelude:')
start = source.index("psql_install <<'SQL'\n", start) + len("psql_install <<'SQL'\n")
end = source.index('\nSQL\n', start)
print(source[start:end])
PY
  psql "$C01_P2_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f supabase/baseline.sql
  psql "$C01_P2_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -c "notify pgrst, 'reload schema'"
fi
ready=0
for _ in $(seq 1 30); do
  if curl --silent --fail "$C01_P2_POSTGREST_URL/" >/dev/null; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { echo 'PostgREST local não ficou pronto.' >&2; exit 1; }
echo "Commit: $(git rev-parse HEAD)"
python3 - <<'PY'
from hashlib import sha256
from pathlib import Path
print('Baseline SHA256:', sha256(Path('supabase/baseline.sql').read_bytes()).hexdigest())
print('Rota reply SHA256:', sha256(Path('app/api/v1/ai/cases/[id]/reply/route.ts').read_bytes()).hexdigest())
PY
pnpm exec vitest run --config vitest.c01-p2.config.mts "$@"
