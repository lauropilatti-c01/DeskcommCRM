# Encerrar a oferta por silêncio — candidata de 24/10

**Implementado e testado em cópia descartável; desligado, sem instalação ou ativação.** Não muda os três rascunhos importados no laboratório. Não há novos campos, tabelas, migrations, transporte ou consumo de IA.

## Contrato

O caminho novo existe somente para grafo com `settings.c01_acompanhamento.kind=oferta` e nó `move_lead` com motivo canônico `no_response`. Esse nó precisa ter uma única saída incondicional para `end` com desfecho `exhausted`, sem continuação. Um grafo legado, cronograma ou vídeo mantém seu comportamento anterior.

A integração e a política precisam estar ativas explicitamente. Sem capacidade aplicada, não se usa o movimento genérico que seleciona o negócio mais recente. Sem configuração ou origem válida não há perda. A variante candidata nasce com `activated_at=null`; não cria inscrições.

A origem assinada identifica organização, contato, conversa, mensagem, produto e **negócio exato**. A versão do grafo é a fixada na inscrição. Destino precisa ser uma etapa existente, não arquivada, de perda e do mesmo funil. O negócio precisa continuar aberto, com o produto da origem. A validação comum de campos obrigatórios continua valendo. `no_response` é motivo já existente no vocabulário do produto.

Exige quatro nós de mensagem concluídos e distintos nessa inscrição, com todos os recibos. Cada bolha precisa estar ligada ao job e à conversa certos, ter confirmação de entrega/leitura e não ter erro. Aceite do transporte sozinho não prova entrega. Recibo ausente, duplicado, revogado, de outra conversa, ledger falho ou bloqueio de marketing não autorizam perda. A política existente mantém a espera de pelo menos 48 horas desde a última entrega/leitura comprovada e os horários permitidos.

Na fronteira do efeito, o leitor financeiro aplicado confere a pessoa, o produto e a oportunidade. Compra cancela; ambiguidade, consulta parcial, erro ou informação com mais de 15 minutos mantém revisão e card aberto. O escritor e o leitor financeiro recusam múltiplas oportunidades abertas. O teste com duas oportunidades mantém a outra já encerrada e prova que o escritor escolhe somente o alvo exato.

Resposta nova, humano, recusa, restrição, retorno combinado ou outra sequência incompatível impedem a perda. Não sobrescreve um Ganho ou Perdido já existente.

## Concorrência, recuperação e trilha

`lib/followup/c01-encerrar-oferta.ts` mantém a trava `callback` compartilhada com compra/retorno, a trava de atendimento `fn_service_lock` e locks das linhas lidas. A ordem é callback → service → inscrição/grafo → contato (`FOR UPDATE`) → conversa (`FOR SHARE`) → todos os negócios do contato, ordenados por ID (`FOR UPDATE`). O contato bloqueia a inserção concorrente pelas FKs; as linhas dos negócios bloqueiam reabertura de uma oportunidade encerrada. Exige uma única aberta, igual à origem, antes da consulta e antes do efeito. Não há trava global. Relê a origem, o estado e os recibos, consulta compras e reavalia o relógio depois da consulta.

A etapa e o motivo são gravados no negócio da origem. O trigger existente define o desfecho. Atividade visível no card, evento de mudança de etapa, auditoria e `fn_followup_apply_step` entram no **mesmo commit**, com CAS da revisão da inscrição. O evento `c01_oferta_encerrada` é recibo de efeito concluído, não de intenção.

Uma falha antes do commit desfaz todo o efeito; o motor conserva o passo e usa sua política existente de nova tentativa. Uma resposta perdida depois do commit é reconhecida pelo recibo, sem segunda movimentação ou eventos duplicados. Bloqueio de negócio fica registrado na inscrição, em revisão ou cancelada conforme a causa. Não existe uma nova fila externa de recuperação.

## Provas e limites

- Dois testes do motor reproduziram o desvio para o seletor genérico e a falha sem propagação antes da correção. O caso de ausência do escritor passou depois do patch; seu ensaio inicial parou por dublê incompleto, portanto não conta como reprodução dirigida de falha.
- A revisão independente reproduziu a inserção de uma segunda oportunidade durante a consulta financeira. A correção passou a proteger o conjunto por contato. Três casos novos foram vermelhos antes dessa correção: inserção anterior, inserção durante a consulta e reabertura concorrente.
- 75 testes focados passaram: motor C01, política de acompanhamento e vocabulário do nó de movimento.
- 35 casos passaram no PostgreSQL descartável com o baseline oficial, incluindo escopo, recibos, intervalo, finanças, concorrência por ambas as travas, ticks simultâneos e falha antes/depois do commit. O teste não usa tabelas reduzidas nem DDL novo de produto.
- Comandos: `pnpm exec vitest run lib/followup/c01-acompanhamento-engine.test.ts lib/followup/c01-acompanhamento.test.ts lib/followup/move-lead-motivo-da-perda.test.ts`; `CONFERENCIA_KIT_RELEASE=v1.86.0 pnpm test:db tests/invariants/c01-encerrar-oferta.test.ts`.
- A fonte financeira é controlada nesses testes, sem API paga. Eles provam a decisão, os vínculos e a atomicidade; não certificam credenciais, cobertura financeira atual ou operação na produção. As corridas usam transações concorrentes reais e a mesma chave de trava; não executam uma compra financeira real.
- Revisão independente aprovada **para integrar OFF**: 75 testes focados, 43 casos SQL (35 desta implementação e 8 adversariais do revisor) e 16 testes do gerador/importador no controle. Confirmou a inserção concorrente aguardando o commit, a preservação do card novo no replay e a ordem das travas com atendimento humano. Parecer privado: `~/workspace/dados/deskcomm-c01/encerramento-oferta-2410/REVISAO-INDEPENDENTE.md`; prova SQL: `revisao-db-corrigido.log` na mesma pasta.
- Typecheck Node 22 e lint dos arquivos alterados passaram. O portão obrigatório da árvore integrada continua a cargo da integração. Não houve consulta financeira real, importação pela API, instalação, ativação ou envio.

**Destino:** ambos. O núcleo recebe uma porta de efeito atômico no motor; o único consumidor é a política C01 opt-in. Sem essa política, o fluxo comum permanece inteiro. A entrega não liga nenhuma sequência nem envia mensagem.
