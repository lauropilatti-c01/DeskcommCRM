# Checagem após o vídeo do curso — contrato candidato

Pedido do Lauro em 23/10/2026: tirar a pergunta imediata após o vídeo do curso e, se a pessoa ficar em silêncio, esperar cerca de 15 minutos antes de perguntar. A sessão comercial altera o texto da Marina. A análise abaixo foi implementada como candidata local desligada; a ficha ao final identifica o código e as provas. Nenhuma configuração ou envio real foi ativado e a copy final continua dependente da confirmação comercial.

## Base examinada antes da implementação

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

A primeira fatia local, autorizada depois desta análise, preserva a sequência já ativa e registra por que o toque extra foi omitido. Ela entrega o caso comum de apresentação durante a conversa sem alterar relógios da oferta/cronograma. Se o objetivo for sempre perguntar após o vídeo mesmo com uma oferta ativa, será necessária a composição abaixo; não ligar um fluxo paralelo como atalho.

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

A análise inicial terminou sem alterar programa ou configuração. A continuação autorizada implementou apenas a candidata local descrita abaixo; produção e texto da Marina permanecem fora desta frente.


## Ficha da implementação local — 23/10/2026

**Estado:** implementado e testado com dados fictícios, OFF; não publicado nem liberado para operar. Base integrada `c1f468e4c` (retorno por modelo, retrato financeiro e V1). A modalidade `video_curso` reutiliza inscrição, job `followup_turn`, transporte fixo, trava da pessoa, ledger e recibos existentes. Não acrescenta DDL, serviço, IA ou callback sem consentimento.

### Contrato de configuração e grafo

`C01_ACOMPANHAMENTO_INTEGRATION.allowedKinds` admite `video_curso`. O objeto opcional `videoCourse` contém `enabled`, `connectionId`, `copyStatus`, `question` e `catalog`. Preparar com `enabled:false` e `copyStatus:"proposed"`. A integração global também fica OFF. O catálogo contém chave estável, produto, URL HTTPS exata e, para vídeo nativo, SHA-256 do arquivo verificado pelo V1. Não há catálogo real preenchido nesta entrega.

Exemplo do objeto opcional, **fictício e desligado**:

```json
{
  "enabled": false,
  "connectionId": "22222222-2222-4222-8222-222222222222",
  "copyStatus": "proposed",
  "question": "Ficou alguma dúvida sobre como funciona?",
  "catalog": [{
    "key": "curso-ficticio",
    "productKey": "produto-ficticio",
    "url": "https://example.invalid/curso"
  }]
}
```

A pergunta é a proposta pedida para o rascunho, **não texto comercial aprovado**. A publicação recusa copy proposta, modalidade OFF, catálogo vazio, conexão indisponível ou grafo diferente de uma pergunta fixa seguida de fim custom. O corte antes do envio reconfere copy, catálogo e grafo; desligar depois de agendar também impede a saída.

Fixture do terceiro rascunho: `docs/c01/fixtures/video-curso-off.json`.

- SHA-256: `113b3f1381cc3f72b990e005d12b575882f4cbebb186a4f289abe9866cabc821`.
- Três nós: `video-inicio` → `video-pergunta` → `video-fim`; duas arestas `always`.
- `settings.c01_acompanhamento = {"version":1,"kind":"video_curso","activated_at":null}`.
- `flowGraphSchema` aceita; `validateFlowForPublish` recusa como `c01_integracao_pendente`. O pré-voo completo também recusa copy proposta antes do RPC. O teste com configuração fictícia aprovada só demonstra a capacidade de publicar, sem executar CRM real.
- O relógio não depende de um nó de espera editável: a política calcula entrega + 15 minutos e o motor agenda a próxima avaliação.

### Identidade, prioridade e prova de envio

O turno captura o resultado executado de `crm_query_external_data` da conexão autorizada, tabela `c01.agente_pagina`, filtro único de `enfase_id`, URL do curso exatamente igual ao catálogo. `pode_afirmar` autoriza argumentos comerciais do plano e **não** autoriza o vídeo: um vídeo canônico continua elegível com esse campo falso ou ausente. Outro schema, tabela, conexão, produto ou URL não serve. Mídia nativa exige o caminho imutável do V1 com organização, conversa e SHA revisados.

A origem assinada inclui chave do vídeo, produto, oportunidade, pessoa, conversa, mensagem e hash do conteúdo. O envio público não pode forjar essa origem; a rota externa de origens continua aceitando somente cronograma/oferta. O link enviado depois da consulta, ou a mídia preparada pelo V1, ainda exige oportunidade aberta única.

O varredor só inscreve após `delivered_at` ou, na sua ausência, `read_at`; apenas `sent` não inicia o relógio. Mesmo vídeo reentregue em outro balão ou replay encontra a inscrição anterior. Outra sequência viva e retorno confirmado mantêm prioridade. O motivo da omissão fica em `metadata.c01_video_omitted`; esse balão não volta a ser inscrito quando a outra sequência termina. Oferta posterior substitui a inscrição de vídeo com evento `c01_sequencia_substituida`. Uma oferta anterior não ganha esse direito por chegar atrasada ao varredor.

Qualquer nova mensagem, inclusive “vou ver com calma”, cancela pelo evento de resposta. O corte final reconfere também humano, recusa, compra, fonte financeira, recibo, expediente, janela e configuração. O toque não usa modelo fora de 24 horas; ao terminar, marca somente a inscrição como concluída, sem contaminar os quatro toques da oferta nem marcar Perdido. `delivered`/`read` não significa assistido.

### Evidência executada e revisão

- Rodada final focada: 32 testes passaram nos três arquivos de vídeo, engine e publicação. Unidade e engine cobrem origem canônica, catálogo, 14:59/15:00, expediente/janela, seis cancelamentos, copy OFF/proposta, envio por `fixed_body` sem `prompt_hint`, encerramento apenas com recibo. Arquivos `c01-video-curso.test.ts` e `c01-acompanhamento-engine.test.ts`.
- Pré-voo: `c01-publicacao.test.ts` prova recusa da proposta e preserva publicação das modalidades anteriores.
- SQL real isolado: 29 testes em `tests/invariants/c01-acompanhamento-runtime.test.ts`, incluindo 13 novos para vídeo. Cobrem origem entregue/lida, replay e novo balão, sequências concorrentes, callback, oferta posterior com histórico, ausência de retroinscrição e mudança de estado entre elegibilidade e porta final. Banco descartável de teste; nenhum dado real.
- Regressões focadas existentes: política de acompanhamentos, origem de oferta e contexto de envio. Typecheck passou; ESLint dos arquivos alterados sem erros (dois avisos antigos em `inbound-turn.ts`). Revisão independente da raiz executou 26 testes e verificou os caminhos de origem, política, SQL e turno. O achado sobre `pode_afirmar` foi corrigido com teste específico.
- Nenhuma suíte completa repetida, rodada paga de IA ou envio de WhatsApp foi usado como prova.

### Limites e próximo passo

Faltam confirmação comercial da pergunta, vínculo real do catálogo/conexão, mapas financeiros coerentes, release pelos portões do projeto e liberação operacional. O importador de rascunhos é da sessão de controle e deve consumir o JSON acima sem ativá-lo. Não há prova de transporte real ou teste no celular nesta frente. A retirada da pergunta imediata no prompt pertence à sessão comercial; esta mudança de programa não reescreve Marina nem skills. Ativar só um dos lados não entrega a experiência completa.
