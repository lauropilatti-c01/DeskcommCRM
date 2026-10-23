# Checagem após o vídeo do curso — contrato candidato

Pedido do Lauro em 23/10/2026: tirar a pergunta imediata após o vídeo do curso e, se a pessoa ficar em silêncio, esperar cerca de 15 minutos antes de perguntar. A sessão comercial altera o texto da Marina. Este documento é análise técnica; não implementa, configura ou ativa envio e não define a copy final.

## O que o código já oferece

- `lib/agent-engine/agent/videos-nativos.ts`, na frente V1, identifica mídia por chave e SHA-256, prepara uma cópia por conversa e envia vídeo/legenda juntos pelo transporte comum. Não agenda uma pergunta posterior.
- `lib/agent-engine/agent/inbound-turn.ts` captura origem de **oferta** pela consulta executada e pelo conteúdo enviado. Vídeo do curso ainda não tem origem específica reconhecida.
- `lib/followup/c01-origem.ts` e `c01-acompanhamento-origens.ts` aceitam `cronograma` e `oferta`. Inscrevem a partir de origem assinada e recibo `delivered`/`read`, sob a trava da pessoa. Apenas oferta pode substituir cronograma por regra explícita.
- `lib/followup/engine.ts`, `c01-acompanhamento.ts` e `c01-acompanhamento-runtime.ts` já têm relógio durável, inscrição única, fila, guardas finais, tentativa e recibos.
- `lib/followup/c01-retorno.ts` é **retorno combinado**, com consentimento e dia/hora. Não serve como atalho para criar uma pergunta automática sem esse consentimento.

Referências examinadas: base `17f862a33`, retorno por modelo `8a19750e5` e frente V1 em `c01/video-2310`. Nenhuma dessas leituras prova liberação em produção.

## Menor implementação integrada recomendada

Adicionar uma modalidade C01 de **toque único após vídeo do curso** ao motor existente, desligada por padrão. Ela usa a mesma inscrição, `followup_turn`, transporte, trava, tentativa e recibos; não cria serviço, cron paralelo, transporte nem tabela. Esta é uma modalidade da única sequência permitida, e não uma segunda sequência concorrente.

1. Identificar exclusivamente o vídeo de apresentação do curso por chave/hash autorizado ou URL canônica exata devolvida pela consulta executada. A presença de qualquer YouTube, Panda ou MP4 no texto não basta. Vídeos de aptidão, carreira, depoimento e técnico não entram automaticamente.
2. O servidor vincula organização, pessoa, conversa, oportunidade, produto, ID da mensagem e hash do vídeo/link. O modelo não fornece a origem pronta nem escolhe o relógio por argumento de ferramenta.
3. Registrar a origem junto do envio real. Para o relógio, reutilizar a prova de entrega das origens C01: `delivered_at`, ou `read_at` quando só esse recibo existe. `sent` significa aceite do provedor; ainda não prova chegada. O vencimento é **confirmação de entrega + 15 minutos**. Nunca começar na consulta da base, preparação da mídia ou frase “enviei o vídeo”. Essa escolha conservadora precisa constar da implementação, em vez de haver dois significados de “envio confirmado”.
4. Se houver silêncio até o vencimento e nenhuma restrição, enviar uma única pergunta comercial previamente aprovada pelo caminho fixo existente, sem chamar IA. A copy e o vínculo exato do vídeo continuam com a sessão comercial. Não preencher com uma frase inventada para fazer o teste passar.
5. Só considerar o toque concluído com seus recibos. Falha ou resultado incerto bloqueia, sem tentar texto alternativo e sem deduzir silêncio. Não contar esse toque como um dos quatro da oferta nem usá-lo para marcar Perdido.

“Entregue”, “lido” e “assistido” continuam diferentes. A pergunta não pode dizer que a pessoa assistiu ou terminou o vídeo. Uma reprodução real só existiria com evidência específica da plataforma, que não faz parte desta proposta.

## Convivência com as regras existentes

| Situação no momento de registrar ou enviar | Tratamento candidato da primeira fatia |
| --- | --- |
| Retorno confirmado pendente | O compromisso vence. Não abrir nem enviar o toque do vídeo. Não mudar seu dia/hora. |
| Oferta com sequência ativa | Preservar os quatro vencimentos e a origem da oferta. Omitir o toque extra do vídeo e registrar o motivo. |
| Cronograma ainda elegível e ativo | Preservar a retomada. Não substituir o fluxo por vídeo silenciosamente. Omitir o toque extra. |
| Cronograma antigo já invalidado por resposta | Reconhecer o cancelamento devido à resposta sob a mesma trava; depois avaliar a nova origem do vídeo. Não tratar como substituição comercial arbitrária. |
| Nenhuma sequência viva | Criar a inscrição de toque único, se origem, oportunidade e configuração forem válidas. |
| Oferta entregue depois do vídeo, antes da pergunta | Regra explícita proposta: cancelar o toque de vídeo pendente e iniciar somente a oferta. Preservar ambos os eventos no histórico. |
| Compromisso confirmado depois do vídeo | Cancelar o toque incompatível, mantendo o retorno com prioridade. |
| Novo vídeo, replay ou segunda entrega do mesmo vídeo | Não criar outro toque para a mesma pessoa/conversa, oportunidade e identidade do vídeo. Um novo balão não zera a deduplicação. |

Omitir o toque quando já há outra sequência é uma **proposta técnica conservadora**, não uma nova decisão comercial já aprovada. Ela entrega o caso comum de apresentação durante a conversa sem alterar relógios da oferta/cronograma. Se o objetivo for sempre perguntar após o vídeo mesmo com uma oferta ativa, será necessária a composição abaixo; não ligar um fluxo paralelo como atalho.

### Extensão posterior, se for exigida

Guardar um evento de checagem auxiliar na inscrição já existente, com origem, vencimento e recibos próprios. O motor escolhe no máximo uma ação devida por pessoa sob a mesma trava, preservando a origem e o nó principal. Isso exige distinguir explicitamente `checagem_video` dos toques de oferta: hoje `lerFatosAcompanhamentoC01` conta eventos `action_sent` como toques. Acrescentar uma ação sem essa distinção poderia transformar a pergunta do vídeo no primeiro toque de oferta e antecipar os demais ou o Perdido. Também seria necessário definir qual mensagem vence se dois horários coincidirem. Por esse motivo, a composição não é apenas adicionar uma espera ao grafo publicado.

## Guardas no vencimento e na porta final

- Resposta depois do vídeo cancela a pergunta pendente; o atendimento normal responde à pessoa. Não rearmar automaticamente porque o silêncio voltou.
- Humano, recusa, restrição, contato mesclado/anonimizado ou oportunidade alterada cancela/bloqueia o efeito incompatível.
- Compra confirmada cancela. Compra ambígua, fonte ausente ou consulta incompleta bloqueia; não inferir que não pagou.
- Respeitar 08h–21h de Brasília e as 24 horas contadas da última mensagem do cliente. A espera de 15 minutos não renova nenhuma dessas janelas.
- Se vencer fora do expediente, a eventual reavaliação às 08h depende de ainda haver janela e contexto válidos. Não há envio automático retroativo em massa, prazo inventado nem modelo de fallback criado por esta proposta. Sem modelo específico aprovado, janela fechada bloqueia.
- Reconsultar configuração ao executar: desligar depois de agendar impede a saída. Preservar assinatura, revisão de atendimento, tentativa persistida e deduplicação até o recibo.

## Pontos de mudança e prova mínima

| Local | Mudança necessária |
| --- | --- |
| `inbound-turn.ts`, `videos-nativos.ts`, identificação canônica de links | Captura confiável do vídeo do curso e transmissão da origem ao envio real. Coordenar com o dono V1; não reconhecer só pelo texto que a IA afirmou. |
| `c01-origem.ts`, `c01-acompanhamento-origens.ts` | Modalidade e prova de vídeo, matrícula única, deduplicação e regra explícita para oferta posterior. |
| `c01-acompanhamento.ts`, `c01-acompanhamento-fatos.ts` | Relógio de 15 min, entrega real, toque único e cancelamentos, sem contaminar os quatro toques de oferta. |
| `engine.ts`, `c01-acompanhamento-runtime.ts`, grafo específico | Reutilizar o job e o envio fixo atuais; manter o mesmo corte final. Só mudar o necessário para a nova modalidade. |
| Configuração/importador e documentação do atlas | OFF, rascunho, identidade real do vídeo/link, copy aprovada e fonte de prova. |

Testes focados, sem IA: (1) tentativa/erro não inicia relógio; entrega do vídeo/link exato inicia; (2) 14:59 não envia e 15:00 é apenas elegível; (3) resposta, humano, recusa, compra ou configuração OFF entre agendar e enviar impede saída; (4) falha de recibo não vira silêncio/reenvio; (5) mesmo vídeo em replay ou novo balão não duplica; (6) retorno/oferta/cronograma mantêm prioridade e relógios; (7) oferta posterior cancela somente o toque de vídeo; (8) 08h–21h e janela fechada não têm atalho; (9) nenhuma mensagem ou estado afirma “assistiu”; (10) envio do toque passa pela trava, ledger e transporte comuns sem chamar IA.

Parada desta tarefa: análise entregue e extensão sinalizada no atlas como candidata. Sem alteração de programa, configuração, texto da Marina, serviço ou produção.
