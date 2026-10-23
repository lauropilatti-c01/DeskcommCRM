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

## V3: executor de acompanhamentos, candidato OFF

Implementação local sobre `c1f468e4c`, em `c01/video-followup-2310`. Os caminhos
`lib/agent-engine/agent/followup-turn.ts` e `lib/followup/enviar-texto-fixo.ts`
leem a mesma política por organização, com `enabled && flow_mp4`. Ausência,
erro de leitura, tipo inválido ou qualquer uma das duas opções desligada recusa
MP4 sem enviar a legenda sozinha. Imagem, PDF e texto preservam seus contratos.
Nenhuma configuração real foi criada ou habilitada.

O nó já existente `action.mode=text` recebe `media_url` terminado em `.mp4` e
`body` como legenda. O tipo enviado é `video`; a mensagem inteira segue pelo
mesmo handler do CRM e o mesmo transporte do canal. Não existe fallback para
link textual, chamada de IA ou novo serviço. O editor não foi redesenhado.

**Limite de origem desta fatia:** a URL do nó é uma configuração do operador;
a extensão identifica o tipo solicitado, mas não comprova bytes, hash, codec
ou conteúdo. Esse caminho não usa `video_chave` nem a cópia privada do catálogo
V1. Não anunciar a validação de hash do V1 para uma URL arbitrária. Antes de
habilitar é necessário aprovar a URL estável e conferir o arquivo/reprodução;
URL que expira pode falhar. Uma futura seleção do catálogo por chave exigirá
contrato específico de nó e fica fora desta entrega.

A legenda precisa ter de 1 a 1024 caracteres, incluindo espaços. O worker
reconfere o corpo após os ajustes da cadeia. O inline usa o corpo fixo que já
veio renderizado. Configuração e legenda são relidas imediatamente antes de
entregar a intenção ao canal/handler. Desligar depois de preparar impede o envio.

Vídeo e legenda têm uma identidade de mídia no ledger comum. No mesmo job,
refazer a legenda não cria uma segunda entrega do mesmo vídeo; a URL precisa
permanecer estável. O worker e o inline usam a mesma forma de identidade.
`queued`, `failed` e indisponibilidade não concluem o passo nem contam entrega.
Uma saída já aceita conserva o recibo no replay. Sem prova de entrega, o motor
C01 continua bloqueando o próximo toque; não interpreta falha como silêncio.

As guardas continuam nos caminhos existentes: inscrição viva, fronteira de
atendimento, elegibilidade, responsável humano, recusa, janela do canal, ritmo
e corte financeiro C01. Vídeo livre não é modelo Meta e não sai fora da janela
de 24 horas. O retorno combinado não recebe vídeo por esse opt-in.

O suporte a vídeo no passo **não ativa a pergunta de 15 minutos** nem escolhe
vídeo por objeção. São capacidades distintas, com configuração própria. Também
não adiciona mídias aos grafos de acompanhamento já preparados. Texto pode ser
liberado independentemente desta candidata.

### Ficha de prova V3

- Vermelho inicial: seis casos novos falharam nos dois executores porque MP4
  continuava recusado como tipo; os demais casos passaram.
- `lib/followup/enviar-texto-fixo.test.ts`: ON/OFF, legenda, janela, configuração
  desligada após preparo, identidade persistida no ledger e recibos sem sucesso.
- `tests/unit/fluxo-envia-modelo-aprovado.test.ts`: mesmos cortes no worker,
  corpo alterado pela cadeia, nenhuma IA, replay real pelo `sendWithLedger`
  sem segundo transporte, e preservação dos modelos/imagens/textos anteriores.
- `tests/unit/c01-videos-nativos.test.ts`: leitura SQL/Supabase da mesma política,
  por organização, OFF em erro; regressão de catálogo, mídia e ledger do V1.
- `tests/unit/c01-video-nativo-handler.test.ts`: handler real com transporte
  simulado, inclusive URL MP4, bloqueio, janela, anti-SSRF real e formato de vídeo com legenda. DNS é simulado; não há download externo.
- `tests/unit/followup-turn-nao-fala-por-cima-de-quem-assumiu.test.ts`: a passagem
  humana permanece antes do envio. Nenhuma prova usou cliente ou canal real.

As rodadas focadas passaram: 38 casos inline, 21 do worker/modelos, 21 de V1/leitura de política, 9 do handler e 5 de passagem humana. ESLint sem erros (dois avisos preexistentes no arquivo de modelos). Typecheck conferido na candidata.

Não houve DDL, gasto de IA, mudança no laboratório compartilhado ou publicação.
Ativação, catálogo comercial, URLs reais, prova no celular e portões da release
ficam com a etapa de liberação da sessão principal.

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
