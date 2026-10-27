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
  plans, description`, iguais ao `publicar.py`. Uma imagem por (plano, gatilho). Campos extras,
  inclusive caminho, são recusados. `description` até 600 unidades UTF-16 e não só espaços.
- `previous` (opcional, até 100): versões já publicadas. Só para retomar uma intenção que o ledger
  já tem e para descrever a versão antiga no histórico. Nunca escolhidas para envio novo.

Arquivos no bucket existente `whatsapp-media`: origem `<org>/biblioteca-imagens/<sha256>.<ext>`;
cópia da conversa `<org>/<conversa>/imagem-<key>-<sha256>.<ext>`, sem sobrescrever. O preparo
confere a assinatura PNG/JPEG, o mime aprovado, 5 MiB e o SHA-256 dos bytes; conflito no destino
confere os bytes existentes. Não decodifica a imagem nem prova como ela aparece no celular.

## Quando sai

1. A resposta é texto puro (sem vídeo nativo nem foto de produto) e não é prévia.
2. O texto leva um link (`link_cartao` ou `link_sem_cartao`) que a consulta `agente_pagina` desta
   resposta devolveu, por aquela conexão, com uma ênfase no filtro e `pode_afirmar`. Quando a
   capacidade está ligada, a consulta ganha as colunas de plano e link que faltarem.
3. O plano daquela linha está nos `plans` de exatamente uma imagem. Duas imagens citadas = só texto.
4. Público restrito: o telefone do contato está em `testPhones`.
5. `primeira_vez`: nenhuma mensagem de saída da conversa inteira (não só o que a Marina lê) tem a
   cópia daquela `key`, em qualquer versão, fora `failed`.
6. Depois de todos os guardas da cadeia, o link ainda está no texto final.
7. Há vaga no teto do turno para a imagem **e** para todas as bolhas do texto. O teto não muda.

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
`previous`, isso só vale quando a mensagem já foi gravada).

## Histórico da Marina e prévia

A mensagem de saída com caminho `imagem-<key>-<sha256>` aparece como
`[Você mandou esta imagem antes do link (imagem <key>, v<N>, <estado>): <description>]`, com o
estado da mensagem (aceita, entregue, falhou, enviando). Nunca como mídia do cliente. A política
só é lida quando há uma dessas mensagens no histórico. Versão que saiu da biblioteca e de
`previous` aparece sem descrição.

A prévia ("testar agente") não copia nem envia: informa em `warnings` se a imagem iria junto
(`imagem_da_pagina`) ou por que não (`imagem_da_pagina_nao_vai`). Não confere teto, arquivo nem
`primeira_vez`.

## Fora desta fatia

Escolher a ênfase pelo card (`enfaseDoCard` existe no módulo, sem ligação: falta saber em que
resposta a Marina grava a ênfase), pedido de reenvio ("manda aquela imagem de novo"),
acompanhamentos automáticos, gravação da configuração (fase 3 do crm-agentico), teste em celular.

## Prova

`pnpm vitest run tests/unit/c01-imagens.test.ts`: contrato (inclusive as fixtures do crm-agentico
com `C01_IMAGENS_CONTRATO_CASOS=<caminho>/lab/imagens/contrato-casos.json`), páginas da consulta,
escolha, arquivo, versão fixada, `primeira_vez`, ordem e teto, histórico e as âncoras da ligação no
turno e na prévia. Storage, banco e canal simulados; sem IA, WhatsApp nem banco compartilhado.
Os contratos vizinhos (fotos, vídeo, retomada com teto cheio, prévia, histórico, uploads
registrados) continuam verdes. Suíte local verde não é capacidade liberada: publicação, teste no
celular e ligação são estados posteriores, com OK do Lauro.
