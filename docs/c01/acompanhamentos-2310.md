# Acompanhamentos C01: candidata de 23/10/2026

## Estado e destino

Extensão C01 no fork, opt-in. Ausência de configuração preserva o caminho legado e bloqueia todo fluxo marcado como C01. A entrega é candidata para publicação posterior: nenhum fluxo, agente, conector ou envio real foi ativado por esta frente. Não há migration, coluna, tabela ou função própria; usam-se mensagens, recibos, jobs, inscrições e eventos já existentes.

O escopo une duas modalidades: retomada do cronograma e acompanhamento de oferta. Retorno combinado tem prioridade sobre ambas. Só existe uma sequência viva por pessoa, incluindo estados pausado, dormente e coletando. Um cadastro não vira oportunidade nova só para receber acompanhamento.

## Configuração mantida desligada

`C01_ACOMPANHAMENTO_INTEGRATION` é JSON privado do servidor, validado em `lib/followup/c01-origem.ts`. Não usar variável `NEXT_PUBLIC_*`. Ausência, JSON inválido ou `enabled:false` deixam a integração desligada. Campos:

| Campo               | Função                                                                             |
| ------------------- | ---------------------------------------------------------------------------------- |
| `enabled`           | Manter `false` até a liberação operacional.                                        |
| `organizationId`    | Organização única autorizada.                                                      |
| `tokenSha256`       | SHA-256 do segredo exclusivo do produtor de origens. Não é token comum de API/MCP. |
| `signingKey`        | Segredo com pelo menos 32 caracteres para assinar a origem e o consentimento.      |
| `allowedKinds`      | Lista contendo `cronograma`, `oferta` ou ambas.                                    |
| `offerConnectionId` | Conexão real da base comercial, obrigatória para a modalidade oferta.              |

Não há valores de credencial neste documento. O operador injeta os segredos pelo mecanismo já usado na instalação. Mudança de segredo de assinatura invalida provas antigas: deve ser tratada como rotação coordenada, sem reativar inscrições antigas em massa.

O produtor externo de cronograma tem sua própria opção `C01_ORIGEM_ACOMPANHAMENTO`, desligada por padrão. Agentes novos ficam com `callback_enabled:false`. A opção `followup.c01_callback:true` seleciona o contrato comercial rigoroso somente depois de a capacidade de callback estar autorizada; não habilita, sozinha, o agendamento.

As duas fontes financeiras são configuradas em `C01_FINANCIAL_INTEGRATIONS_JSON`, pelo contrato de `lib/leads/configuracao-financeira.ts`. Acompanhamento exige Guru e boleto habilitados, conta e mapas de produto/oferta coerentes, e os IDs dos respectivos fluxos em `commercialFlowIds`. O espelho em observação, um campo editável de pagamento ou a etapa Ganho não substituem essas fontes.

## Preparar os fluxos e os modelos

1. Criar os grafos pelo construtor/API normal, usando os textos e intervalos aprovados no plano de operação. Salvar como rascunho. `settings.c01_acompanhamento` contém `version:1`, `kind:"cronograma"` ou `kind:"oferta"` e `activated_at:null`.
2. Usar nós de ação compatíveis com o canal. Para fora da janela de 24 horas, cadastrar o modelo Meta e aguardar aprovação na conta correta. Um rótulo local de “aprovado” não cria um modelo na Meta. O contrato atual aceita modelo sem variáveis pendentes; falta de modelo ou canal conectado bloqueia o envio.
3. Associar os IDs dos fluxos à configuração do agente e aos mapas financeiros. O produtor só encontra uma inscrição se houver exatamente um agente automático publicado e habilitado para o fluxo.
4. Conferir o rascunho. Com ativação nula ele continua recusado como `c01_integracao_pendente`; isso é esperado durante a preparação.
5. Na liberação combinada, configurar as fontes de verdade e clicar em Publicar na plataforma. A rota confere configuração no servidor, mapas de Guru/boleto equivalentes, organização, canal, conexão comercial e ausência de outra política ativa da mesma modalidade. Depois, atribui a hora atual do servidor à primeira ativação; republicar preserva o instante da versão ativa. O rascunho com ativação nula não exige edição técnica intermediária. Datas do cliente nunca antecipam a origem e não existe booleano do navegador que dispense as conferências.
6. O pré-voo prova coerência de configuração, não saúde da API financeira nem pagamento Meta: o envio relê as fontes e os recibos reais. Falta de cobertura, falha de fornecedor ou recusa de pagamento deixam pendência. A ativação e o teste no celular continuam pertencendo à etapa de liberação autorizada pelo Lauro.

Não há inscrição retroativa. Uma mensagem enviada antes da ativação continua inelegível mesmo que a confirmação de entrega chegue depois.

## Origem: do conteúdo autorizado à entrega comprovada

**Cronograma.** O serviço de entrada marca somente o balão decidido pelo motor confiável com `c01_origin:{kind:"cronograma",product_key}`. O gancho preserva o negócio original da decisão; o transporte interno passa `HandlerCtx.c01Origin={kind,leadId,productKey}`. Isso não atravessa o texto do modelo.

**Oferta.** O runtime captura exclusivamente o resultado executado de `crm_query_external_data` na conexão autorizada, schema `c01`, tabelas `agente_pagina` e `agente_links`. Vincula o produto ao filtro efetivamente consultado. Na consulta de links, completa a projeção real com produto, plano, status e autorização antes de executar. Só produz origem quando a URL exata autorizada aparece na mensagem que será enviada e existe uma única oportunidade aberta com o produto correspondente. Uma URL inventada, uma etapa ou JSON devolvido por outra ferramenta não servem.

**Persistência.** A porta real de envio reserva o UUID da mensagem e assina organização, contato, conversa, negócio, produto, modalidade e hash do conteúdo. `metadata.c01_origin` recebido pelo corpo público é sobrescrito: só o contexto interno pode gerar a prova. A assinatura acompanha a mensagem persistida; alteração do conteúdo invalida a prova.

**Recibos.** `sent` significa aceite pelo provedor e não matrícula. O varredor chamado pelo relógio de follow-ups só considera `delivered`/`read`, com ID externo e instante real. Confere de novo produto, identidade, resposta posterior, atendimento humano, bloqueios, versão ativa e prioridade de callback. Matricula sob trava e transação. A inscrição nasce vencida pelo relógio do banco (`next_eval_at` usa o default `now()`), sem atraso adicional por desvio do relógio do processo. Pagina por UUID em lotes de 200; uma pessoa fora do primeiro lote não desaparece.

**Porta alternativa para produtor autenticado.** `POST /api/internal/c01/acompanhamentos/origens` exige bearer exclusivo cujo hash corresponde à configuração. Corpo estrito: `message_id`, `lead_id`, `kind`, `product_key`. Não recebe organização nem contato do chamador. Lê ambos da mensagem real e da configuração. Retorna 201 na matrícula, 200 no replay, 409 para origem inelegível e 503 se desligado/indisponível. Chave de idempotência: modalidade + UUID real da mensagem. Ainda exige entrega confirmada; não aceita o identificador sintético do porteiro como recibo.

## Decisão, envio e recuperação

A seleção consulta `lib/followup/c01-acompanhamento-fatos.ts`: inscrição e grafo pinado, origem assinada, contato, conversa, oportunidade, callbacks, outras sequências, jobs, ledger e mensagens com recibos. A fonte financeira é `lerSituacaoFinanceira` e retorna confirmação, revisão, indisponibilidade ou negativa com cobertura completa. Ausência de compra no espelho não autoriza uma negativa.

Antes do transporte, texto, mídia e template passam novamente pela guarda comum em `app/api/v1/messages/_handler.ts`. O servidor retém a mesma conexão PostgreSQL com a trava `callback:<organização>:<contato>` durante a decisão e o transporte. O registro financeiro e o agendamento usam a mesma chave. Perda da trava impede o próximo efeito; não se descarta o recibo de um envio que já foi aceito.

Uma tentativa é persistida antes da saída para o canal, em evento da inscrição ou payload do job de callback. Se o processo cair depois do POST e antes do recibo, o reprocessamento fica bloqueado como entrega indeterminada. Não repete automaticamente. Várias bolhas só avançam quando as anteriores têm recibo real. Falha, limite de marketing, ausência de pagamento Meta e recibo ausente não contam como silêncio nem como toque entregue.

Uma resposta nova, atendimento humano, recusa, compra ou restrição cancela/invalida a sequência. A retomada do cronograma não concorre com a sequência de oferta. O retorno combinado cancela a cadência C01 daquela pessoa. Não altera cadências legadas de terceiros.

A política recalcula o instante de envio dentro de 08h–21h de Brasília. O último minuto é 20h59. O cronograma usa o limite de 23 horas desde a última mensagem do cliente; a oferta começa após duas horas da entrega. A janela do WhatsApp é relida ao executar. Mensagem fora da janela exige caminho de modelo aprovado; não se transforma texto livre em template. A marcação Perdido requer quatro toques inteiramente entregues, 48 horas após o último, ausência de resposta e conferência financeira completa para a oportunidade.

## Retorno combinado e limite da linguagem (M13)

O callback comercial consulta o `inbound_message_id` do job verdadeiro do turno. O modelo não precisa inventar IDs de mensagem. Uma confirmação curta usa exclusivamente a proposta imediatamente anterior na mesma conversa, entregue ao provedor e sem mensagem intermediária. IDs explícitos, quando fornecidos, precisam pertencer à pessoa e ao turno.

O verificador usa uma gramática pequena, não um julgamento de intenção por IA. Exemplos aceitos:

- Cliente: “Pode me chamar amanhã às 9h.”
- Marina: “Posso te chamar amanhã às 9h?” → cliente: “Sim!”.
- Cliente: “Vamos conversar 24/10 às 14:30.”

Alternativas (“9h ou 10h”), condicionais (“se eu conseguir”), perguntas ainda sem confirmação, negação e frases indiretas são recusadas. O modelo recebe instrução para confirmar um único dia e horário nesse formato. A recusa nunca antecipa ou escolhe uma das alternativas.

Antes de criar o cron, a ferramenta prova consentimento, oportunidade, situação atual, capacidade financeira e horário executável. Como o callback por IA ainda não seleciona um template determinístico, rejeita já na criação um horário igual ou posterior a 24 horas da última mensagem de consentimento. Não promete hoje para bloquear amanhã. Na execução, relê janela, compra, resposta, atendimento humano e hash das mensagens.

Reagendamento usa o ID pendente e comparação do estado anterior, sob a mesma trava, sem cancelar e criar em duas chamadas. Só `ok:true` permite dizer que o horário foi registrado. O cliente nunca recebe promessa de antecipação para caber no horário comercial. Não há prova de linguagem com IA paga nesta entrega; os testes determinísticos e de SQL comprovam a fronteira técnica descrita.

## Evidências reproduzíveis

- Testes focados dos contratos: `pnpm exec vitest run lib/followup/c01-retorno.test.ts lib/followup/c01-origem.test.ts lib/followup/c01-origem-oferta.test.ts lib/followup/c01-publicacao.test.ts lib/followup/c01-acompanhamento.test.ts lib/followup/c01-acompanhamento-engine.test.ts lib/agent-engine/agent/schedule-followup.test.ts lib/followup/retorno.test.ts tests/unit/escrita-do-turno-escopo.test.ts tests/unit/c01-acompanhamento-sink.test.ts`.
- SQL em cluster descartável: `TEST_DB_PORT=<porta> C01_TEST_DB_USER=<usuário> pnpm exec vitest run --config vitest.c01-acompanhamento.config.mts`. O teste cria e remove só seu schema sintético. Doze cenários passaram: origem/entrega, idempotência, concorrência, compra antes do envio, queda sem recibo, exclusividade, consentimento, callback e portas físicas de texto/mídia. A ferramenta nativa foi chamada com o job real e sem IDs fornecidos pelo modelo, com consentimento direto e confirmação curta; o horário persistido foi conferido.
- A revisão independente executou os mesmos caminhos no baseline integral: nove cenários aprovados em `experiments/extensoes/c01-atendimento/acompanhamento-baseline.test.ts`, incluído pela frente de verificação. Também conferiu frases adversariais do M13, enriquecimento da oferta e portão de publicação.

Nenhuma dessas provas representa envio WhatsApp real, modelos aprovados na Meta, publicação do agente ou liberação de produção. A frente de integração executa o portão obrigatório sobre a árvore final antes da janela de publicação.
