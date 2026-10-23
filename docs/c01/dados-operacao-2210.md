# Dados do negócio e proteção financeira — candidata de 22/10/2026

Estado: implementado na candidata e verificado por testes locais. Não publicado,
não ligado à produção, sem nova tag e sem migration/DDL. Integração e portões de
publicação pertencem à sessão principal. A base da frente é `6515a40c8`.

## Comportamento e contrato

1. **Contexto do card.** A mesma projeção é usada na consulta inicial e depois do
   gancho. Campos declarados vêm primeiro, depois os nativos, depois os demais.
   O resumo com definição de funil aceita até 70 campos, 512 caracteres por valor
   e 32.768 caracteres no bloco. Esses são limites máximos: o contexto inteiro
   ainda precisa caber no orçamento configurado. Sem definição de funil, os
   limites anteriores de 20 campos, 120 caracteres e 800 caracteres permanecem.
2. **Limite não é ausência.** `campos_do_card_limites` informa `omitidos` e
   `truncados`; texto parcial termina com reticência. `campos_do_card_vazios`
   distingue chave vazia presente de valor omitido. `false` e `0` permanecem
   respostas. Chaves privadas e de dados pessoais continuam excluídas, inclusive
   dessas listas. Não há nova regra comercial para calcular pendências no TS.
3. **Leitura explícita.** `campos_do_card_leitura` vale `lido` ou
   `sem_card_unico`. Esta última situação não afirma que não existe negócio: pode
   haver mais de um candidato. Falha da consulta é `crm_unavailable`, nunca um
   card aparentemente vazio. Um contexto que continua grande após reduzir o
   histórico também é recusado. Os metadados chegam à projeção consumida pelo
   modelo; não ficam apenas na resposta interna da consulta.
4. **Gravação.** O handler exige recibo válido de `fn_lead_anotar_campos` com as
   chaves pedidas. `NULL`, formato inválido ou recibo incompleto gera
   `lead_fields_not_confirmed`, com orientação para reler. O retorno continua
   trazendo o que o banco confirmou, inclusive respostas negativas.
5. **Pendências.** `qualificacao_pendente` vazio continua significando lista
   limpa. Seu cálculo único pertence ao serviço do porteiro/motor no projeto de
   operação; o Deskcomm não introduz cálculo paralelo nem preenche dados ausentes.

Exemplo coberto: 41 campos preenchidos, com `decisao_concurso`,
`conhece_preparacao`, `tempo_por_dia` e `qualificacao_pendente` no fim, chegam à
projeção do modelo. Uma observação de 180 caracteres preserva sua conclusão.
Isso não demonstra que a versão publicada da Marina escolhe as ferramentas
corretas: a prova de conversa real continua sendo outra etapa.

## Confirmação financeira

`pagamento_confirmado` é convenção reservada do fork, sem metadado novo que a tela
pudesse apagar e sem alteração do schema. Criação/edição genérica, MCP e escrita
junto com movimento recusam a chave (`financial_field_read_only`), qualquer que
seja seu valor. Informar `source`, recibo ou confirmação no corpo da chamada não
concede autorização.

A validação compartilhada impede Ganho quando o funil exige essa confirmação,
mesmo que um booleano já esteja no banco ou seja proposto pelo diálogo. A regra
vem antes da visibilidade, escopo e parser tolerante de campos, para não sumir
com uma definição legada inválida. O erro `financial_verification_required` não
abre o diálogo de preencher um campo comum. Sem conseguir ler as regras do
funil, Ganho é recusado. Movimentos comuns e funis que não exigem a confirmação
financeira mantêm sua regra anterior.

A criação direta em etapa Ganho também passa pela verificação: o trigger
existente fecha o negócio no INSERT, e a dispensa de campos da captação não pode
contornar esse efeito. Encerramento e movimento existentes consomem a mesma
validação de domínio.

**Limite material:** esta candidata não contém escritor financeiro autenticado.
Logo, Ganho nos funis protegidos fica indisponível até esse caminho ser concluído
e provado. Não é autorização para desligar o campo obrigatório. Não foi criado
um atalho por actor, segredo no corpo ou booleano de confiança. O sincronizador
observacional de compras não vira escritor por causa desta mudança.

Estas são proteções dos caminhos de aplicação cobertos, não uma política nova do
Postgres contra escrita SQL direta. Acesso privilegiado ao banco, importações ou
futuras integrações exigem sua própria conferência. A conciliação de transação,
produto e oportunidade é uma entrega separada.

## Provas locais

- Testes sintéticos de contexto: 41 campos, texto negativo, vazio conhecido,
  limites explícitos, falha de leitura e orçamento insuficiente.
- Testes dos handlers reais com banco em memória: filtros de organização,
  criação/edição/MCP, criação direta em Ganho, ausência de recibo e releitura dos
  campos gravados. O dublê aplica filtros de organização; isto não substitui o
  teste de RLS no banco real do portão obrigatório.
- Testes do encerramento compartilhado: confirmação genérica já gravada e
  configuração indisponível não geram UPDATE nem atividade de ganho.
- Regressões de contexto, gancho, campos exigidos e ações relacionadas. Os novos
  cenários reproduziram falhas antes da correção.
- Rodada final: 10 arquivos, 146 testes aprovados, zero falhas. As provas novas
  e dos handlers financeiros também passaram em conjunto (3 arquivos, 60 testes).
- Typecheck aprovado com `NODE_OPTIONS=--max-old-space-size=8192`; a execução
  padrão excedeu o heap de 4 GB. Lint dos 14 arquivos TS afetados: zero erros e
  dois avisos preexistentes em `inbound-turn.ts`.
- `pnpm release:conferir` aprovou o fragmento sem escrever versão nem tag.
  O cálculo de versão do autor não substitui o processo de tags do fork.

Comando das provas novas e dos handlers financeiros:

```sh
pnpm exec vitest run tests/unit/c01-dados-contexto-integridade.test.ts \
  tests/unit/lead-so-liga-contato-e-responsavel-da-mesma-empresa.test.ts \
  lib/leads/encerramento.test.ts --maxWorkers=1
NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck
```

Não foram executados testes pagos, conversas externas, leitura de dados de leads
ou implantação. O portão completo da versão será executado uma vez pela sessão
principal após a integração das frentes.

## Integração no inventário e no guia

A sessão principal atualiza `C01.md` e o inventário global, incluindo:

- contexto: constantes 70/32.768/512 e `projetarCamposDoCard`, leitura, vazio e
  limites na consulta, no gancho e na projeção do prompt;
- gravação: recibo obrigatório de `fn_lead_anotar_campos`;
- financeiro: reserva da chave, recusas distintas, validação compartilhada antes
  de efeitos e criação direta em Ganho;
- limite operacional: escritor financeiro ausente, candidato não publicado.

No guia, explicar que campo vazio conhecido é diferente de falha de leitura, e
que o relato de pagamento não autoriza marcar Ganho. Mostrar a integração de
compras como observação até existir o escritor e sua prova; não anunciar o
encerramento automático como ativo.
