# Retorno combinado: cancelamento definitivo — candidata de 24/10/2026

Estado: correção isolada, aprovada pela revisão independente para integração
com a operação desligada. Não houve publicação,
ativação, mensagem, IA paga ou consulta financeira externa nesta entrega.
Destino: extensão opcional C01 nos retornos e adaptação dos caminhos comuns
para preservar a exceção específica; retornos legados conservam o contrato.
Sem coluna, índice, função SQL ou migração nova.

## O que mudou

Antes, `c01_callback_human`, resposta nova ou compra confirmada impediam o
instante do envio, mas eram falhas comuns: a fila podia tentar novamente. Se
um sinal sumisse, a mesma promessa podia voltar a enviar.

Agora há dois desfechos distintos:

| Fato no corte de envio | Desfecho |
| --- | --- |
| Resposta posterior válida; atendimento humano; recusa/restrição; consentimento ou proposta revogados; compra confirmada por conferência completa e atual | Cancela aquela promessa definitivamente. |
| Fonte indisponível, conferência financeira incompleta/ambígua/vencida, relógio ou inbound incertos, configuração/modelo ausentes e transporte com erro | Não envia, não conta entrega e conserva a política de nova tentativa existente. |

Confirmado sem prova completa e atual continua sendo incerteza. Ausência de
`last_inbound_at`, data inválida ou futura não prova uma resposta nova.
O relógio inválido também não autoriza o envio. O contrato financeiro permanece
vinculado à organização, pessoa, oportunidade e produto da prova assinada.

## Persistência e recuperação

O verificador lança `RetornoC01CanceladoError` somente para os fatos terminais.
A exceção atravessa o handler, a borda CRM e o adapter intacta; não se transforma
em `CrmTransportError`, erro genérico ou falso recibo de envio.

O worker usa o lease original, preservando microssegundos, em duas etapas:

1. Sob bloqueio do job atual, registra o evento nativo
   `conversation.autonomous_turn_revoked`, com organização, job e conversa,
   `entity_kind=job` e `status=done`. A releitura evita duplicar o evento.
2. Em nova transação, reconfirma o lease, marca mensagens preparadas como
   `failed`, invalida recibos ainda pendentes e cancela o job. Não rebaixa
   mensagens/recibos já enviados ou aceitos.

A separação é intencional: uma queda depois da primeira gravação deixa o veto
persistido. O reaper pode recuperar o trabalho, mas a guarda nativa encontra a
revogação e executa a limpeza antes de qualquer envio. Lease antigo não revoga
nem cancela a tentativa nova. Falha antes de persistir o primeiro fato não é
cancelamento concluído: o job fica sem conclusão e a falha precisa aparecer na
operação. Não existe garantia de persistência quando o próprio banco recusa a
escrita.

O resgate genérico de mensagens `queued` não possui o contrato de consentimento
nem a conferência financeira. Portanto, mensagens ligadas pelo `send_ledger` a
um job `followup_turn`, `scope=commercial` e `c01_callback` ficam fora desse
resgate, na seleção e na releitura final. Outros envios preservam o caminho
anterior. Uma mensagem C01 presa por indisponibilidade do canal não passa a ter
permissão de envio direto: exige recuperação pelo caminho que revalida o retorno
ou tratamento operacional. Esta entrega não cria outro reenviador.

## Provas e limites

Rodada do autor: **45 testes unitários e 22 provas SQL aprovados**, além de
22 verificações do fragmento, lint e tipos. A revisão independente aprovou
50 unitários e 38 cenários SQL distintos, incluindo os canônicos de
revogação/lease. Após encontrar um recibo aceito com espelho ainda `queued`,
a limpeza foi corrigida para preservar o aceite. Só o arquivo afetado e o
caso adversarial correspondente foram repetidos; não se alega reexecução
integral de todas as provas na árvore corrigida.

A prova exercita ferramenta real → prova/cron persistidos → scheduler →
`claimJobs` → `withServiceJob` → handler → canal fictício → disposição real.
Também passa pela trava e pelo verificador reais do sink. Banco descartável
PostgreSQL 15 com baseline oficial; organização, pessoa, agente, oportunidade,
canal e modelo são fictícios. O papel `service_role` foi exercitado na escrita
da revogação. Nenhuma permissão de atendente autoriza essa operação interna.

Casos: resposta, humano, compra, recusa e revogação seguidos da retirada do
sinal; fonte completa versus incompleta/vencida/futura/inválida; retry com
backoff; erro de transporte; relógio/configuração; lease antigo; mensagem
preparada; queda entre commits; erro ao persistir o veto; resgate legado;
propagação do erro pelos dois cortes de envio. Os testes unitários preservam a
regressão dos modelos e do watchdog.

Comandos focados, com Node 22 e sem serviços externos:

```sh
pnpm test:unit tests/unit/c01-retorno-terminal-handler.test.ts tests/unit/c01-retorno-terminal-edge.test.ts lib/followup/c01-retorno-modelo.test.ts lib/agent-engine/agent/followup-turn-c01-modelo.test.ts lib/agent-engine/edge/crm/session-reconciler.test.ts
CONFERENCIA_KIT_RELEASE=v1.86.0 pnpm test:db tests/invariants/c01-retorno-terminal.test.ts
NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck
```

A prova executa as peças do worker sem iniciar seus loops. Fonte financeira e
transporte são fictícios; o modelo aprovado é somente um registro de fixture.
Não comprova modelo aprovado na Meta, credencial financeira, WhatsApp real,
ativação ou configuração publicada. A leitura de tela/guia e o portão da árvore
integrada pertencem à sessão integradora. A publicação segue o caminho normal
da versão; a configuração continua desligada. Voltar o programa retira esta
correção, portanto não autoriza ativar os retornos durante a volta.
