# Confirmação de persistência no webhook Meta — candidata de 24/10/2026

Estado: candidata local, sem publicação, sem alteração de banco e sem mudança em envios. Não libera a manutenção com atendimentos abertos.

## Contrato

A assinatura, a resolução do token e o parser continuam nos caminhos existentes. O código deixa de confirmar com HTTP 200 um `failed` que o ingestor já informou. Se algum evento falhar, a resposta do lote é 503 com `Retry-After: 30`; os demais eventos continuam sendo tratados. Esse cabeçalho é uma sugestão, não prova do prazo de reentrega da Meta.

| Resultado | Resposta |
|---|---|
| Mensagem com ID retornado pelo INSERT | 200, salvo outra falha no mesmo lote |
| Conflito 23505 seguido de releitura exata: organização, ID externo, sessão e direção | Duplicata confirmada; 200, sem repetir os efeitos da mensagem |
| Conflito sem essa prova, consulta indisponível ou INSERT sem ID confirmado | 503 |
| Número comprovadamente ausente/arquivado após consulta bem-sucedida (`no_session`), evento irrelevante ou descarte deliberado | 200; não produzir tentativas inúteis |
| Falha ao consultar a sessão | `failed`, portanto 503; não confundir com ausência confirmada |
| Falha retornada pela escrita de estado de mensagem/modelo | 503 |
| Token desconhecido, assinatura inválida e payload inválido | Mantêm 404, 401 e 400 respectivamente |

A confirmação de duplicata vale para entrada e eco do WhatsApp Business. A reação mantém o seu contrato existente. O número/organização do corpo não vira autoridade: o tenant vem da sessão resolvida pelo token.

## Prova e limites

Os testes da rota usam assinatura, parser e ingestor reais, com resposta de banco controlada. O ensaio SQL usa o baseline canônico no PostgreSQL 15 descartável e as RPCs reais de contato, conversa e carimbo. Só o transporte Supabase → PG é adaptado para o teste; suporte/telefone e efeitos comerciais usam seams determinísticos, sem IA nem canal externo.

Casos principais: falha no segundo item de um lote; reentrega sem repetir o primeiro; conflito sem prova; tenant/sessão/direção diferentes; falha de leitura; assinatura/payload/token; erro de status/modelo; lock real na tabela de mensagens; oito requisições concorrentes com uma linha; mesmo ID externo em outro tenant.

O teste de resposta perdida após commit prova um limite anterior a esta mudança: a mensagem fica gravada, a reentrega relê a duplicata e não a duplica, mas os efeitos pós-entrada que não começaram não são reparados por este corte. O ACK confirma ingestão, não conclusão do turno, carimbo, download de mídia ou despacho. As falhas best-effort desses caminhos mantêm o contrato e os registros existentes.

Não foram provados nesta fatia: reentrega real da Meta, prazo do provedor, troca de imagens, interrupção de um processo durante o pós-entrada ou recuperação de todos os efeitos. Nenhum ensaio simulado autoriza afirmar que uma mensagem real foi atendida. A manutenção permanece dependente de fechar e provar essas fronteiras.

Comandos focados:

```sh
pnpm exec vitest run tests/unit/meta-ack-persistencia.test.ts
CONFERENCIA_KIT_RELEASE=v1.86.0 pnpm test:db tests/invariants/meta-ack-persistencia.test.ts
```

O banco e os contêineres são os descartáveis alocados pelo harness oficial. Os registros completos das rodadas ficam fora do Git, em `~/workspace/dados/deskcomm-c01/meta-ack-2410/`.
