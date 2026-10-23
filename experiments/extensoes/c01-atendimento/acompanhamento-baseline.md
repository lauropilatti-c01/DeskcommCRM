# Prova complementar: acompanhamento no baseline integral

Esta receita exercita o SQL real de matrícula, fatos de entrega, concorrência, tentativa de envio e retorno combinado. Usa as tabelas existentes do `supabase/baseline.sql`, sem substituir o esquema por um recorte. As pessoas, organizações e oportunidades são fictícias, com UUIDs novos a cada teste. Não cria nem remove tabelas.

Prepare o banco descartável pela [receita do atendimento](README.md). Para esta parte, PostgreSQL basta; PostgREST não é utilizado:

```sh
C01_P2_DATABASE_URL='postgresql://postgres@127.0.0.1:55441/c01_p2_jornada' \
  pnpm exec vitest run --config vitest.c01-acompanhamento-baseline.config.mts
```

O destino deve ser PostgreSQL em `127.0.0.1`, banco `c01_p2_*`, sem parâmetros na URL. O comando insere apenas fixtures. Elas permanecem no banco descartável. A configuração padrão do Vitest exclui `experiments/extensoes/**`; esta prova entra somente pela configuração própria.

Em revisão de uma cópia isolada, `C01_REVIEW_SOURCE` pode apontar para a raiz relativa da candidata. O alias usa o código dessa raiz, sem copiar módulos para a bancada. Depois da integração, omita essa variável e teste o código da própria árvore.

## O que comprova

- Mensagem aceita pelo provedor, mas sem confirmação de entrega, não abre acompanhamento.
- Matrículas repetidas ou concorrentes não criam duas sequências.
- Mensagem anterior à ativação não entra retroativamente.
- Resposta entre o aceite e a confirmação de entrega impede a matrícula.
- Compra identificada entre a seleção e o transporte impede a chamada de envio.
- Tentativa registrada sem recibo não autoriza uma repetição cega.
- A trava impede dois transportes simultâneos e é liberada ao terminar.
- Falha ou ausência de recibo não vira evidência de silêncio.
- Retorno combinado exige consentimento compatível, prazo executável e nova conferência antes de enviar.
- Cancelar a cadência para priorizar um retorno preserva o job de outra pessoa.

## Limites e evidência

O leitor financeiro é simulado com estados explícitos. O transporte é uma função de teste, sem WhatsApp, modelo ou pessoa real. O cliente Supabase usado nas consultas da política é um dublê. O restante das consultas, transações, trava e tabelas é real. Esta receita não comprova credenciais, ativação nem entrega em produção, e não substitui os testes do handler de mensagens ou a prova financeira completa.

Em 23/10/2026, o conjunto inicial passou **8/8** às 08h57. Foram acrescentadas a negativa de origem anterior à ativação e a asserção de preservação do job de outra pessoa; os **2 cenários afetados** passaram às 09h00. O arquivo final contém **9 cenários**. O baseline integral tinha SHA256 `7e27fac9827a10d24556b2579b5ff85cde9dcff9c4c95f7a16ac11637cb4f7bb`.
