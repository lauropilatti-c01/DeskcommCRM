#!/usr/bin/env python3
"""Bancada descartável: esquema oficial, Storage/PG reais e provedor HTTP fictício."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import socket
import struct
import subprocess
import wave

ROOT = Path(__file__).resolve().parents[1]
EXCLUIR = 'realtime,studio,mailpit,postgres-meta,imgproxy,edge-runtime,logflare,vector,supavisor'

def run(args, **kwargs):
    return subprocess.run(args, cwd=ROOT, check=True, **kwargs)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('acao', choices=['start', 'test', 'stop'])
    parser.add_argument('--state', type=Path, required=True, help='Pasta privada fora do repositório.')
    parser.add_argument('--base-port', type=int, default=58320)
    args = parser.parse_args()
    state = args.state.resolve()
    if state == ROOT or ROOT in state.parents:
        raise SystemExit('Use uma pasta fora do repositório.')
    os.umask(0o077)
    meta_file = state / 'bancada.json'
    if args.acao == 'start':
        if state.exists() and any(state.iterdir()):
            raise SystemExit('start exige pasta nova/vazia; não reaproveita nem apaga outra instalação.')
        for porta in [args.base_port + i for i in (0, 1, 2, 3, 4, 9)]:
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', porta))
        state.mkdir(parents=True, exist_ok=True)
        project = 'c01-audio-' + hashlib.sha256(str(state).encode()).hexdigest()[:10]
        config = (ROOT / 'supabase/config.toml').read_text()
        config = re.sub(r'^project_id = .*$', f'project_id = "{project}"', config, flags=re.M)
        for i in (0, 1, 2, 3, 4, 9):
            config = config.replace(str(54320 + i), str(args.base_port + i))
        (state / 'supabase').mkdir()
        (state / 'supabase/config.toml').write_text(config)
        shutil.copytree(ROOT / 'supabase/templates', state / 'supabase/templates')
        meta = {'project': project, 'base_port': args.base_port,
                'baseline_sha256': hashlib.sha256((ROOT / 'supabase/baseline.sql').read_bytes()).hexdigest()}
        meta_file.write_text(json.dumps(meta, indent=2) + '\n')
        # Sem migrations históricas: instalação fresca usa apenas o baseline oficial.
        with (state / 'infra.log').open('w') as log:
            run(['supabase', '--workdir', str(state), 'start', '-x', EXCLUIR], stdout=log, stderr=subprocess.STDOUT)
            container = f'supabase_db_{project}'
            run(['docker', 'exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c',
                 'create extension if not exists "uuid-ossp"; create extension if not exists pgcrypto; create extension if not exists vector; create extension if not exists citext; create extension if not exists pg_trgm;'], stdout=log, stderr=subprocess.STDOUT)
            with (ROOT / 'supabase/baseline.sql').open('rb') as sql:
                run(['docker', 'exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], stdin=sql, stdout=log, stderr=subprocess.STDOUT)
        print(f'Bancada própria pronta: {project}; API local na porta {args.base_port + 1}.')
        return
    meta = json.loads(meta_file.read_text())
    config = (state / 'supabase/config.toml').read_text()
    if f'project_id = "{meta["project"]}"' not in config or not meta['project'].startswith('c01-audio-'):
        raise SystemExit('Identidade da bancada não confere.')
    identidade = run(['docker', 'inspect', f'supabase_db_{meta["project"]}', '--format', '{{index .Config.Labels "com.supabase.cli.project"}}'], capture_output=True, text=True).stdout.strip()
    if identidade != meta['project']:
        raise SystemExit('O container não pertence à bancada informada.')
    if args.acao == 'stop':
        # Encerra SOMENTE esta instância; sem --no-backup (não remove volumes).
        run(['supabase', '--workdir', str(state), 'stop'])
        return
    current_sha = hashlib.sha256((ROOT / 'supabase/baseline.sql').read_bytes()).hexdigest()
    if current_sha != meta['baseline_sha256']:
        raise SystemExit('Baseline mudou. Crie outra bancada; não atualizamos a existente.')
    result = run(['supabase', '--workdir', str(state), 'status', '-o', 'json'], capture_output=True, text=True)
    cfg = json.loads(result.stdout)
    if cfg['API_URL'] != f'http://127.0.0.1:{meta["base_port"] + 1}' or f'127.0.0.1:{meta["base_port"] + 2}/' not in cfg['DB_URL']:
        raise SystemExit('Portas da bancada não conferem.')
    audio = state / 'fixture.wav'
    with wave.open(str(audio), 'wb') as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(16000)
        f.writeframes(b''.join(struct.pack('<h', int(1000 * math.sin(2 * math.pi * 440 * i / 16000))) for i in range(16000)))
    # Não herda chaves de IA, destinos de produção nem .env da instalação.
    env = {k: os.environ[k] for k in ('PATH', 'HOME', 'TMPDIR') if k in os.environ}
    env.update(NEXT_PUBLIC_SUPABASE_URL=cfg['API_URL'], NEXT_PUBLIC_SUPABASE_ANON_KEY=cfg['ANON_KEY'],
               SUPABASE_SERVICE_ROLE_KEY=cfg['SERVICE_ROLE_KEY'], SUPABASE_DB_URL=cfg['DB_URL'],
               C01_AUDIO_FILE=str(audio), NODE_ENV='test', DB_POOL_MAX='2', EVENT_LOG_WORKER_DRAINS='true')
    run(['pnpm', 'exec', 'vitest', 'run', '--config', 'vitest.c01-audio.config.ts'], env=env)

if __name__ == '__main__':
    main()
