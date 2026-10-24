# F01 — despacho recuperável depois da entrada

Estado: contrato local em implementação. Não autoriza manutenção nem recuperação de contatos reais.

## Fatos no código atual

1. `fn_emit_message_event` gera `message.received` no mesmo commit de `messages`. Essa outbox existe sem nova migration.
2. `aplicarEfeitosPosEntrada` faz opt-out, origem, card, campanha, avanço/envio de acompanhamento, pedido de despacho e dreno. Há efeitos fora de uma transação única e erros best-effort.
3. `emit_event` gera outro UUID a cada pedido de despacho. A fila deduplica por `source_event_id`, portanto repetir o pedido pode criar outro turno para a mesma mensagem.
4. Ausência de despacho não demonstra ausência de outros efeitos. Repetir a função inteira em uma mensagem encontrada no banco seria replay cego.

## Menor fatia segura

Dar ao pedido de despacho uma identidade estável por organização e mensagem. Antes de gravar, conferir vínculo da mensagem com contato, conversa, sessão e direção; reaproveitar evento anterior exato (inclusive o legado com UUID aleatório). Um conflito só prova repetição depois da releitura do evento. Mais de um evento legado ou vínculo divergente é revisão, nunca autorização para criar mais um.

A fila existente continua usando esse evento como `source_event_id`, preservando a deduplicação do job e do envio. Não refazer card, pagamento, acompanhamento ou bloqueio para recuperar somente o despacho.

## Fronteira ainda aberta

O primeiro corte não cria prova retroativa de que os passos anteriores terminaram. Um recuperador precisará de recibo durável de prontidão antes do despacho; sem ele, a janela deve recusar a operação para a entrada ambígua. Um simples `metadata.done` depois da função best-effort também não basta: ela pode ter retornado apesar de falha interna.

Alternativas avaliadas: redispatch de toda duplicata (recusado, duplica turnos); reaplicar todos os efeitos de `message.received` (recusado, pode avançar acompanhamento); recibo explícito e recuperação por etapa comprovada (caminho conservador, ainda por fechar).

## Prova prevista

Teste primeiro: uma mensagem repetida/concorrente conserva um evento e um job; perda da resposta do INSERT não duplica; evento antigo exato é preservado; tenant/vínculos divergentes e leitura indisponível bloqueiam. PostgreSQL descartável, sem IA/canal. Depois, medir a fronteira restante antes de apresentar a manutenção como utilizável.

## Primeiro corte local entregue

`registrarDespachoPorMensagem` relê a mensagem e os vínculos; conserva evento legado exato ou grava identidade UUID estável no `event_log`. Conflito é relido. O chamador da entrada Meta opta por esse caminho; os demais continuam no contrato anterior. O serviço e o tratamento dos eventos não mudaram.

Provas do autor: 12 RED de asserção no código anterior (inclusive 2 e 8 pedidos criando 2 e 8 eventos); 67 testes unitários verdes, contando o contrato anterior do pós-entrada; 6 testes no baseline canônico PG15, com fila `enqueueJob` real. Oito chamadas concorrentes resultaram em um evento e um job; a perda da resposta depois do commit foi recuperada sem criar outro evento. Container descartável removido.

Isso é uma base para recuperação do despacho, não um recuperador ligado. Não existe varredura, cron ou redispatch de duplicatas nesta fatia. Não reexecuta outros efeitos. Eventos históricos apagados pela retenção e múltiplas gerações simultâneas de escritores não foram provados como recuperáveis; nenhuma rotina pode usar este helper para reapresentar histórico sem delimitação e prova adicionais.

Continua faltando o recibo da fronteira anterior. Em especial, não há autorização para usar o retorno bem-sucedido da função best-effort como prova de que opt-out, card, campanha e acompanhamento terminaram. A manutenção deve barrar uma entrada sem prova suficiente, sem restaurar banco antigo.
