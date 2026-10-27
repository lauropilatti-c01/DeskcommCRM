# Biblioteca de imagens: capacidade candidata, desligada

Junto da página de pagamento, o atendimento manda sozinho uma imagem aprovada (hoje, a arte do
Vitalício). A Marina não escolhe a imagem e o prompt não muda. A fonte das fichas é o
crm-agentico (`lab/imagens/biblioteca.yaml`, ramo `imagens/biblioteca`); o contrato compartilhado
fica em `lab/imagens/contrato-v1.json` do crm-agentico. Não cria tabela, coluna nem rota.

## Configuração

`organizations.settings.c01_imagens`, por organização:

```json
{ "enabled": false, "audience": "somente_celulares_de_teste", "connectionId": null, "testPhones": [], "items": [] }
```

- Ausente, inválida ou ilegível: desligada. Ligada exige `connectionId` (a conexão de dados da
  consulta `agente_pagina`, a mesma `conexao.id` que `ofertasDaConsultaC01` confere) e, com o
  público restrito, ao menos um celular de teste em E.164, sem repetição.
- `items`: `key, version, sha256, mime, bytes, width, height, triggers, position, frequency,
  plans, description`, iguais ao `publicar.py`. Um gatilho só, de 1 a 100 planos. Uma imagem por
  (plano, gatilho). Campos extras, inclusive caminho, são recusados. `description` até 600
  unidades UTF-16 e não só espaços.
- `previous` (opcional, até 100): versões já publicadas. Só para retomar uma intenção que o ledger
  já tem. Nunca escolhidas para envio novo.

Arquivos no bucket existente `whatsapp-media`: origem `<org>/biblioteca-imagens/<sha256>.<ext>`;
cópia da conversa `<org>/<conversa>/imagem-<key>-<sha256>.<ext>`, sem sobrescrever. O preparo
confere a assinatura PNG/JPEG, o mime aprovado, 5 MiB e o SHA-256 dos bytes; conflito no destino
confere os bytes existentes. Não decodifica a imagem nem prova como ela aparece no celular.

## Quando sai

1. É resposta ao lead (`inbound_turn` ou `case_reply_turn`, o `eTurnoDeResposta`): o acompanhamento
   automático (`followup_turn`) nem lê a política. A resposta é texto puro (sem vídeo nativo nem
   foto de produto) e não é prévia (a prévia simula, inclusive de acompanhamento).
2. O texto leva, exato, um link (`link_cartao` ou `link_sem_cartao`) que a consulta `agente_pagina`
   desta resposta devolveu, por aquela conexão, com uma ênfase no filtro e `pode_afirmar`. A
   comparação é a da trava de link (`linksNoTexto` + `normalizarLink`): `…/vitalicio-anual` não
   vale por `…/vitalicio`. Quando a capacidade está ligada, a consulta ganha as colunas de plano e
   link que faltarem.
3. O plano daquela linha está nos `plans` de exatamente uma imagem. Duas imagens citadas = só texto.
4. O card do contato não contradiz: `produto_chave` (a mesma chave de `agente_pagina.enfase_id`),
   lido na hora do preparo, depois de qualquer `update_lead_field` do turno. Vazio = sem
   contradição; card ilegível = só texto.
5. Público restrito: o telefone do contato está em `testPhones`.
6. `primeira_vez`: nenhuma mensagem de saída da conversa inteira (não só o que a Marina lê) tem a
   cópia daquela `key`, em qualquer versão, fora `failed`.
7. Depois de todos os guardas da cadeia, o link exato ainda está no texto final.
8. Há vaga no teto do turno para a imagem **e** para todas as bolhas do texto. O teto não muda.

Qualquer item que falhe: sai só o texto, como hoje, e o motivo vai ao log do turno
(`imagem da página não vai` ou `imagem da página: sem_vaga`). A Marina não é avisada.

## Envio, recibo e versão

A imagem é uma mensagem própria, sem legenda, pelo mesmo `enviarPeloCanal`, ledger e handler da
foto do catálogo, seguida da pausa anti-ban e do texto pelo caminho de sempre. Bloqueio (opt-out)
ou canal indisponível param a resposta inteira, como nas fotos; falha registrada da imagem não
segura a página. A identidade no ledger é a mídia (caminho com `key` e `sha256`) com corpo vazio:
a re-execução do mesmo job reconhece a imagem já aceita ou pendente e não manda de novo; com o
teto cheio, ela entra no plano da retomada como primeira mensagem. Se a v2 foi publicada entre as
tentativas, a retomada procura a versão anterior em `previous` no ledger e manda a mesma (sem
`previous`, isso só vale quando a mensagem já foi gravada). Identidade que o ledger já conhece
(aceita ou pendente) vai de novo ao ledger antes de `primeira_vez` e sem nova cópia: a linha da
própria tentativa não barra a retomada, e a origem que sumiu do Storage não larga o recibo pendente.
A escolha (itens 1 a 5) continua valendo na retomada: se a ficha foi desligada ou o card mudou no
meio, sai só o texto e a pendência fica como está.

A linha da imagem leva o retrato em `metadata.c01_imagem` (`key, version, sha256, description`),
também no envio pela retomada. Sem coluna nova.

## Histórico da Marina e prévia

A mensagem de saída com caminho `imagem-<key>-<sha256>` aparece como
`[Você mandou esta imagem antes do link (imagem <key>, v<N>, <estado>): <description>]`, com o
estado da mensagem (aceita, entregue, falhou, enviando). Nunca como mídia do cliente. A descrição
vem do retrato da própria mensagem, não da ficha atual; retrato ausente, malformado ou de outra
imagem = sem descrição. A política não é lida para o histórico.

A prévia ("testar agente") não copia nem envia: informa em `warnings` se a imagem iria junto
(`imagem_da_pagina`) ou por que não (`imagem_da_pagina_nao_vai`), com o card lido na hora. Não
confere teto, arquivo nem `primeira_vez`.

## Fora desta fatia

Pedido de reenvio ("manda aquela imagem de novo"),
acompanhamentos automáticos, gravação da configuração (fase 3 do crm-agentico), teste em celular.

## Prova

`pnpm vitest run tests/unit/c01-imagens.test.ts`: contrato (inclusive as fixtures do crm-agentico
com `C01_IMAGENS_CONTRATO_CASOS=<caminho>/lab/imagens/contrato-casos.json`), páginas da consulta,
escolha, link exato, card, arquivo, versão fixada, `primeira_vez`, ordem e teto, histórico e as
âncoras da ligação no turno e na prévia. A costura (`prepararImagemDaResposta` e
`enviarImagemDaPagina`, as duas funções que o turno chama) roda com dublês de consulta, card,
Storage, ledger e canal: caminho feliz até o histórico, guarda que tira o link, teto sem vaga,
retry incerto, recibo pendente com `primeira_vez`, origem sumida e card mudado no turno. Não roda
`runAgentTurn` (modelo, MCP e Postgres reais; o harness de turno inteiro pede Postgres): a ordem
das chamadas dentro do turno fica provada só pelas âncoras. Sem IA, WhatsApp nem banco compartilhado.
Os contratos vizinhos (fotos, vídeo, retomada com teto cheio, prévia, histórico, uploads
registrados) continuam verdes. Suíte local verde não é capacidade liberada: publicação, teste no
celular e ligação são estados posteriores, com OK do Lauro.
