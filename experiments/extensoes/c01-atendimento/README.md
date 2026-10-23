# Prova P2: atendimento com banco e permissões reais

Esta bancada executa o percurso de caso → atribuição comercial → resposta interna → assumir → devolver. Usa o `supabase/baseline.sql` completo, PostgreSQL com pgvector e PostgREST. As funções de autorização, RPCs, RLS, consultas e rotas são as do programa. Somente o login/cookie e a ausência de sessão de suporte e de push são substituídos no teste. Os usuários e negócios são fictícios.

Não comprova login pelo navegador, a facilidade das telas, chegada de push ou entrega no WhatsApp. Não executa modelo nem transporte de mensagem. O handler de continuidade é chamado apenas enquanto o atendimento humano precisa barrá-lo antes dessas saídas.

## Executar localmente

Tenha PostgreSQL 15 com pgvector e PostgREST 16.5, ambos exclusivos desta prova e ligados a `127.0.0.1`. Crie um banco vazio chamado `c01_p2_jornada`. O usuário de instalação precisa poder aplicar o baseline. Não use produção, laboratório compartilhado ou banco com dados reais.

Configure o PostgREST para esse banco, com `db-schemas = "public"`, `db-anon-role = "anon"` e uma chave JWT sintética de pelo menos 32 caracteres. Depois configure o terminal:

```sh
export C01_P2_DATABASE_URL='postgresql://postgres@127.0.0.1:55441/c01_p2_jornada'
export C01_P2_POSTGREST_URL='http://127.0.0.1:55442'
export C01_P2_JWT_SECRET='c01-isolated-synthetic-verification-key-only-2310'
C01_P2_INSTALL_BASELINE=1 bash scripts/test-c01-atendimento-baseline.sh
```

O script extrai o prelude da receita oficial `scripts/test-db.sh` e aplica o baseline inteiro, com parada no primeiro erro. Sem `C01_P2_INSTALL_BASELINE=1`, apenas executa a prova no banco previamente preparado. Cada execução cria identificadores aleatórios; o banco continua descartável. Encerre os serviços e descarte somente o banco desta bancada ao terminar.

O script recusa host externo, nome de banco fora de `c01_p2_*`, parâmetros que poderiam sobrescrever o destino e chave JWT sintética curta. A suíte recusa fetch externo. A prova negativa de indisponibilidade revoga e restitui, no próprio banco descartável, a leitura de `conversations` pelo papel `authenticated`; não desliga RLS.

## CI opcional e resultados

O workflow **C01 atendimento — baseline e RLS (opcional)** roda por `workflow_dispatch`. Sobe PostgreSQL e PostgREST exclusivos, aplica o mesmo baseline e chama a mesma receita. Não está nos testes rápidos nem substitui os portões obrigatórios. Não foi acionado durante a revisão local.

A regressão original, na árvore `3045e1d1400c`, foi reproduzida: um agent sem visibilidade da conversa recebeu HTTP 200 ao responder pelo endereço direto, resolveu o caso e criou um job de continuidade. A correção é validada exigindo HTTP 404, estado e histórico intactos e nenhum job novo. Gestor, responsável autorizado, isolamento entre organizações e falha da leitura também fazem parte da prova.

Os 155 invariantes de banco executados separadamente no baseline integral passaram. Eles não são repetidos por esta receita. O relatório da execução focal deve registrar o commit, os hashes do baseline e da rota `reply`, o resultado do arquivo `percurso.test.ts` e as limitações acima.

Em 23/10/2026, às 08h42 (Brasília), a receita local concluiu **12/12 testes** em 3,17 s, sobre a base `3045e1d1400c` com a correção de `6cfe57613` aplicada à rota. O baseline tinha SHA256 `7e27fac9827a10d24556b2579b5ff85cde9dcff9c4c95f7a16ac11637cb4f7bb`. A listagem da configuração padrão do Vitest não incluiu este arquivo; ele só entrou pela configuração dedicada. Seis chamadas negativas à receita recusaram host externo, parâmetro de host, banco comum, HTTP externo, credencial HTTP e chave curta antes de executar a suíte. O workflow remoto permanece **não executado**.
