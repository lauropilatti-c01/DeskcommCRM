# Continuação contextual L1/L2 — candidata local

Estado: primeira fatia do contrato, sem publicação, matrícula ou envio. As políticas e os textos continuam candidatos. Sem DDL ou alteração do texto/skills da Marina.

## Desenho

Uma ferramenta opt-in C01 recebe, durante o turno já existente, uma proposta estruturada: pedido ainda aberto ou encerramento/pausa/recusa/compra informada/humano. A proposta traz o ID da mensagem de entrada, trecho literal do pedido e, para L1, o texto contextual. Não existe chamada nova de modelo para preparar a retomada. `next_action`, etiquetas e campos comerciais mutáveis não dão autorização.

O servidor reconcilia organização, pessoa, conversa, oportunidade/produto, job, entrada e última saída. Só depois de o job estar concluído e de a saída final ter recibo comprovado poderá registrar a candidatura assinada e matricular. Um agradecimento isolado não prova pedido aberto. A interpretação do modelo continua sendo uma proposta, não prova semântica independente: o contrato confere vínculo e vetos conservadores; os cenários comerciais precisam validar a classificação no turno.

- **L1:** um toque, nunca antes de duas horas da entrega final; somente na janela de 24 h e entre 08h e 21h. Se a espera termina fora do horário, só adia para 08h se ainda couber na janela. Não compete com oferta.
- **L2:** conserva mensagem/entrega da oferta original e seus recibos. O índice seguinte deriva dos toques já entregues; os prazos 2 h/D+1/D+3/D+7 continuam calculados pela oferta original. Uma nova resposta acrescenta apenas uma espera mínima de duas horas de silêncio; não zera a sequência nem permite vários toques imediatos. Quatro toques usados ou recibo incompleto bloqueiam.
- Resposta nova, equipe/caso, recusa, compra informada, pausa, retorno consentido e outra sequência viva barram a candidatura. Os mesmos fatos, com compras autenticadas, serão relidos no envio.
- Uma sequência por pessoa e deduplicação ficam nos mecanismos existentes, sob a trava por pessoa. Origem/ligação da continuação ficam em JSON assinado e eventos existentes. Aguardar `job_queue.status=done` evita confundir ferramenta chamada com turno concluído.

O recibo pode existir com `status=sent`: o estado isolado não comprova entrega nem a invalida. Usa-se a precedência de erros de `estadoDoToque` e data de entrega/leitura. Na primeira fatia essa leitura vale só para o contrato novo; nenhuma regra de origem legada mudou.

## Etapas de implementação e prova

1. Contrato puro e cenários de identidade, entrega, janela, vetos e orçamento. Não matricula.
2. Ferramenta no turno e persistência assinada; matrícula atômica depois do job concluído, dedup e revalidação. Provar em PostgreSQL descartável, sem modelo/canal externos.
3. Integração ao mesmo motor: L1 com texto já preparado; L2 com histórico da oferta raiz. Revalidar na seleção e na fronteira do envio. Preservar `cancel_on_reply:true`.
4. Modelos por conexão + ID + hash exatos do catálogo lido pelo servidor. Ausência de modelo/catálogo/página bloqueia; etiquetas A1/O2 não comprovam conteúdo. D+3 variável não ganha substituto silencioso.
5. Revisão independente única e integração pela coordenação. Portão da árvore final posterior; nenhuma etapa aqui autoriza ativação ou mensagem real.

Comando focado desta fatia: `pnpm exec vitest run lib/followup/c01-continuacao.test.ts`.
