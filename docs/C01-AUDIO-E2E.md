# Prova isolada de áudio — 23/10/2026

## Escopo e estado

Bancada local do circuito interno de mídia, sem mudança de runtime. Não publica
configuração, não chama IA paga, não recebe dado real e não reprocessa produção.
Base examinada: `b5e12d38d2c14cf3934b8151dfe29364627d4d68`.

A preparação da instalação está no repositório de controle, em
`lab/producao/audio_ambiente.py` e `docs/loops/audio-transcricao-2026-10-23.md`.
Esta prova complementa `tests/unit/c01-transcricao-http-local.test.ts`, que
alcançava o HTTP de transcrição, mas não a fila, Storage e contexto.

**O que é real:** PostgreSQL, PostgREST, Supabase Storage, esquema oficial
`supabase/baseline.sql`, handler de entrada `dispatchWahaEvent`, adapter WAHA,
`event_log`, reclamação e retry do dreno, os dois workers de mídia, upload e
download dos bytes, atualização de `messages` e consulta `getLeadContext`.
Os workers rodam em outro processo; a prova não chama `deriveMessageMedia`
diretamente, não troca os clientes de banco/Storage nem fabrica sucesso na fila.

**O que é fictício:** organização, canal, contato, áudio WAV de um segundo
(onda de 440 Hz, 32.044 bytes), servidor de origem da mídia e endpoint HTTP de
transcrição. O endpoint recebe o multipart real e responde com texto fixo
marcado `[RESPOSTA FICTÍCIA]`. Esse texto não é apresentado como reconhecimento
da fala. As chaves também são fictícias, sem acesso a provedores.

## Percursos comprovados

| Percurso | Prova esperada e observada |
|---|---|
| Áudio novo | Entrada cria a mensagem e o evento de persistência; o primeiro ciclo grava os bytes no Storage e emite a derivação; o segundo faz o POST multipart local e grava `ready`. SHA-256 do arquivo, Storage e corpo recebido são iguais. O texto aparece nas mensagens do contexto. |
| Duplicata e replay | Reentrega do mesmo `external_id` mantém uma mensagem. Evento de derivação repetido encontra `ready`, registra `already derived` e não chama o endpoint outra vez. |
| Falha antiga | Fixture de três dias atrás, com mensagem `failed` e evento `dead`, permanece idêntica. Um áudio novo funciona na mesma instalação sem reabrir o antigo. |
| Provedor recusa | Endpoint local responde 401 em cinco tentativas. O dreno real incrementa `attempts`, agenda retries e termina em `dead`. A mensagem fica `failed`, com motivo `transcription_401` e o marcador de mídia não interpretada no contexto. Nenhuma mensagem outbound é criada. |

São **4 testes de integração**. A rodada inicial completa passou em **12,84 s**;
a bancada final criada pelo runner passou em **11,26 s**, e a sessão raiz
repetiu os quatro casos em **11,12 s**, sem falhas. A prova negativa adianta somente
`next_attempt_at` do evento fictício para não esperar os intervalos reais. Não
altera `attempts`, o resultado do handler ou o status final esperado.

A seleção dos consumidores é explícita: o processo de mídia registra somente
`media_persist_v1` e `media_derive_v1`; não roda o worker comercial nem chama
modelo de conversa. A entrada mantém seus efeitos internos reais. Sem agente
publicado ou sequência ativa na organização fictícia, não há atendimento ou
disparo decorrente desses efeitos.

## Configuração relevante encontrada

O serviço dedicado usa `TRANSCRIPTION_API_KEY`, `TRANSCRIPTION_BASE_URL`,
`TRANSCRIPTION_MODEL=whisper-1` e `TRANSCRIPTION_LANGUAGES=pt`. A prova confere
credencial, modelo, idioma e bytes no HTTP recebido. A chave OpenAI genérica
permanece vazia; a chave fictícia OpenRouter serve apenas para a resolução da
configuração do chat que o worker existente faz antes da escada de transcrição.
Nenhuma chamada de chat é permitida.

O worker aplica a política de destinos antes de enviar o áudio. Na bancada,
`IA_DESTINOS_INTERNOS_PERMITIDOS=127.0.0.1/32` libera exclusivamente o endpoint
fictício local pelo mecanismo existente. Não há mudança dessa política em
produção. Na tentativa inicial sem essa autorização, a política recusou a
chamada e gravou o marcador de mídia não interpretada: esse ensaio não foi
contado como transcrição bem-sucedida.

O runner herda somente `PATH`, `HOME` e `TMPDIR`; não carrega `.env` nem chaves
reais. O teste e cada processo de mídia restringem o `fetch` nativo às três
origens locais explícitas e recusam redirecionamentos. Os transportes permitidos
continuam reais. Antes de semear, o teste recusa banco com organização que não
seja fixture `audio-*`.

## Executar sem tocar no laboratório compartilhado

Pré-requisitos: Docker, Supabase CLI, Python 3, Node e dependências da worktree.
O projeto Supabase recebe ID exclusivo derivado da pasta da bancada. As portas
padrão são 58320–58329, conferidas antes do start. A pasta precisa ser nova e
fora do repositório. Só o baseline oficial é aplicado; nenhuma migration própria.

```sh
python3 scripts/c01-audio-e2e.py start --state /tmp/c01-audio-prova
python3 scripts/c01-audio-e2e.py test --state /tmp/c01-audio-prova
python3 scripts/c01-audio-e2e.py stop --state /tmp/c01-audio-prova
```

Se a faixa estiver ocupada, `start --base-port 58330` escolhe 58330–58339. O
runner verifica o projeto no arquivo de configuração e no label do container,
os endereços locais e o hash do baseline antes de testar. Não usa nem modifica
`deskcomm-lab`, `deskcomm-crm` ou outro projeto Supabase existente.

`stop` encerra somente os containers próprios, preservando os volumes, sem
`--no-backup`. Evidências brutas e credenciais locais ficam na pasta privada da
bancada; não entram no Git. Um ensaio incompleto pode deixar eventos pendentes
na própria bancada: nesse caso, usar outra pasta e faixa livre para repetir,
sem resetar banco compartilhado ou mascarar os eventos da tentativa anterior.

## Limites que continuam explícitos

- O handler de mídia usado é WAHA com origem HTTP local. Não prova a rota pública
  autenticada do webhook, assinatura da Meta, token da conexão, download Graph
  ou CDN da Meta. Não abrimos a allowlist de mídia da Meta para acomodar o teste.
- Não mede a precisão do Whisper, idioma reconhecido a partir de fala, custo
  real ou disponibilidade do fornecedor. O resultado de transcrição é falso e
  rotulado para esse fim.
- Não executa o turno comercial da Marina nem entrega resposta no WhatsApp.
  Prova apenas que a consulta real de contexto contém o texto derivado.
- Não prova aplicação das quatro variáveis na VPS, recriação de app/worker,
  integração do compose de produção ou comportamento de produção após restart.
- Retry financeiro continua distinto de replay: o áudio já `ready` não é
  retranscrito. Se o fornecedor tiver respondido e o banco falhar antes de
  persistir `ready`, uma nova chamada paga ainda pode ocorrer no runtime atual.
- A fixture antiga comprova preservação de evento `dead`/mensagem `failed`;
  não autoriza reabrir áudios antigos nem purgar sua fila.
- O programa já precisa resolver a configuração de chat da organização antes
  de chegar ao serviço dedicado. Esta prova tem configuração fictícia válida;
  não afirma que somente uma chave de transcrição substitui a configuração
  necessária de chat em instalação ainda vazia.

## Ficha final

- Código de produto alterado: **nenhum**.
- Banco: baseline oficial em instância descartável, sem DDL próprio.
- Testes afetados: os quatro percursos acima; sem suíte integral ou rodada paga.
- Revisão independente: sessão raiz leu runner, cerca de rede, worker e
  asserções; executou os 4 casos com o resultado acima. Escopo e limites
  mantidos, sem bloqueio identificado.
- Publicação/ativação: não executadas; fora desta entrega.

Identidade dos artefatos de prova:

- Baseline SHA-256: `7e27fac9827a10d24556b2579b5ff85cde9dcff9c4c95f7a16ac11637cb4f7bb`.
- Áudio SHA-256: `6551f09a3e1b384b870b063fe3f6e43f93ec93f6657fa5277b7ccd9754ac08f4`.
- Tamanho: 32.044 bytes, WAV PCM mono de 16 kHz.
- ESLint dos arquivos novos: zero erros e zero avisos.
- Compilação Python do runner: passou.
- Typecheck geral: não aprovado nesta base. A primeira execução atingiu o
  limite padrão de heap. Com `NODE_OPTIONS=--max-old-space-size=8192`, terminou
  com três diagnósticos herdados fora dos arquivos desta entrega:
  `inbound-turn.ts:4146/4149` (`job` possivelmente nulo) e
  `dados-externos-perfil-c01.test.ts:34` (`valor: unknown` incompatível com o
  schema). Nenhum diagnóstico nos seis arquivos novos. A integração precisa
  conferir esses pontos no main atualizado; não foram editados por esta frente.

Continuidade: a branch `c01/audio-e2e-2310` permanece aberta para integração pela
sessão raiz, que coordena as outras alterações do fork. A bancada exclusiva
será desligada após a revisão; os volumes locais permanecem guardados.
