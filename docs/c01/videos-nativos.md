# Vídeo nativo: capacidade candidata, desligada

V1 conecta `send_message.video_chave` ao envio comum do CRM. Não cadastra vídeos,
não muda o texto do agente, não ativa fluxos e não cria tabela nem coluna.

## Configuração e arquivos

A configuração vive em `organizations.settings.c01_native_videos`, por organização:

```json
{
  "enabled": false,
  "flow_mp4": false,
  "catalog": []
}
```

Cada item aprovado de `catalog` tem somente `key` (letras minúsculas, números,
`_` e `-`) e `sha256` (64 caracteres hexadecimais). A configuração ausente,
inválida, ilegível ou desligada recusa vídeo. A implementação não grava essa
configuração. A tabela comercial que escolhe qual vídeo cabe em cada conversa
continua pendente de aprovação e não é deduzida pelo código.

O MP4 aprovado fica no bucket privado já existente `whatsapp-media`, em
`<organization_id>/native-videos/<sha256>.mp4`. A cópia da conversa fica em
`<organization_id>/<conversation_id>/video-<sha256>.mp4`. O modelo fornece apenas
a chave; nunca caminho, organização, URL ou assinatura. Duas chaves do mesmo
arquivo apontam para a mesma cópia. UUIDs e hash são validados; campos extras
no catálogo, inclusive caminho arbitrário, são recusados.

O preparo confere MIME, cabeçalho do contêiner MP4, limite próprio de 16 MiB e
SHA-256 dos bytes. Upload não sobrescreve. Conflito no destino exige conferir os
bytes existentes: encontrar o mesmo nome não basta. A validação não decodifica o
vídeo nem comprova codec, conteúdo comercial ou reprodução no aparelho; essas
provas são necessárias para cada arquivo aprovado antes de habilitar.

## Envio, recibo e falhas

A legenda e o vídeo são uma mensagem só, depois dos guardas comuns do turno.
O handler existente verifica dono da conversa, atendimento humano, recusa e a
janela do canal, e assina a URL do Storage por 600 segundos somente no transporte.
A assinatura não entra na identidade do recibo.

Legenda vazia ou acima de 1024 caracteres não sai; isso vale também após os
ajustes da cadeia. Não há divisão em legenda separada seguida de vídeo. Misturar
`produto_codigo` e `video_chave` é recusado. Mídia ausente ou inválida não degrada
para uma mensagem dizendo que o vídeo foi enviado.

O ledger existente cobre repetição do mesmo job. Para vídeo, a identidade é a
mídia estável, sem a legenda regenerada: recuperar o job com outra formulação
não envia o mesmo arquivo de novo. Aceite, fila, falha e transporte indisponível
continuam distintos. Recibo incerto é reconciliado pelo caminho existente.
Isso não cria uma proibição permanente de reenviar o arquivo em outra conversa
ou em um novo pedido; essa política comercial não foi definida nesta fatia.

A prévia do agente ainda não prepara vídeo. Ela mostra impedimento explícito e
não aprova a legenda como prova de anexo. Testes desta entrega usam ferramentas,
Storage e recibos simulados, sem WhatsApp, IA paga ou banco compartilhado.

## V3: contrato preparado, executor ainda pendente

O classificador de mídia aceita um opt-in `videoMp4: true`. Chamadas antigas
continuam limitadas a imagem/PDF. O contrato de canal e o corpo do handler já
preservam `type: video`. Isso, sozinho, não liga vídeo nos acompanhamentos.

A integração V3 precisa ler a configuração no worker e no executor inline,
exigir `enabled && flow_mp4`, recusar legenda grande e preservar janela, compra,
resposta, humano, recusa e recibo. Ela não deve atrasar a versão dos acompanhamentos.
O editor, a tabela trava→vídeo, os arquivos reais e a habilitação não foram alterados.

## Prova e operação

Teste focado: `pnpm vitest run tests/unit/c01-videos-nativos.test.ts`.
O teste `tests/unit/c01-video-nativo-handler.test.ts` exercita o handler real com
transporte simulado: janela vencida, recusa, troca de responsável, objeto de outra
organização e envio de um vídeo com legenda e assinatura de 600 segundos.
Os contratos adjacentes de foto e mídia também devem permanecer verdes.
Typecheck: `NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck`.

Destino desta mudança: núcleo opcional no fork privado. Sem configuração ativa,
a operação comum permanece como antes. Depois de habilitado, o resultado aparece
na conversa e no ledger existentes; erro volta como erro de ferramenta e o turno
nunca registra falha como entrega. Não há rota, tabela nem tela paralela.

Publicação, teste em celular e habilitação são estados posteriores. Uma suíte
local verde não significa vídeo liberado para leads.
