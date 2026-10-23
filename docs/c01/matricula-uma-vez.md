# T5 — parágrafo de matrícula sem repetição

Estado: implementação isolada, OFF por padrão. Não publicada nem habilitada.
Fonte: pacote Marina v36 versão 2, T5; parecer de 23/10 e orientação de coordenação.
P4 (reescrever o parágrafo comercial) continua separado. Nenhum texto da Marina ou skill mudou aqui.

## Contrato

`organizations.settings.c01_matricula_once` aceita `enabled: true`, `literal` e
`offer_connection_id` (UUID da conexão aprovada de ofertas). Ausência, OFF ou
configuração inválida preservam o legado. O literal vem da configuração comercial;
não há copy C01 embutida no programa. Não há migration nem DDL.

As páginas vêm apenas de resposta estruturada de `c01.agente_pagina` ou
`c01.agente_links`, da conexão configurada, pelo validador existente
`ofertasDaConsultaC01`. Uma URL escrita pela IA, um caso, uma nota ou um vídeo
auxiliar não identifica a página da matrícula.

No envio, depois dos guardas e sob o lock já usado pelo canal, o helper consulta
mensagens outbound ligadas ao `send_ledger`, da mesma organização, pessoa e
conversa. Usa a conexão já retida pelo canal, sem pedir outra ao pool; um
SAVEPOINT recupera a transação se a consulta falhar. Agrupa as bolhas por job. Não usa atividade do card nem declaração da IA
como prova de envio. Não há limite de dias que faça esquecer a primeira ocorrência.

- `sent` significa aceite do envio. É suficiente para não enviar outra cópia,
  mas não comprova entrega no aparelho. `delivered` e `read` também impedem repetição.
- `queued`, `sending` e estado desconhecido de uma mensagem registrada seguram
  somente o literal; não viram entrega confirmada e não autorizam outra cópia.
- Se uma parte do literal falhou explicitamente, aquela tentativa não prova o
  parágrafo completo. Uma nova tentativa permanece possível se nenhuma outra
  ocorrência estiver aceita ou pendente, inclusive dentro do mesmo job.
- Em falha da consulta, somente o literal aguarda conciliação; o link e a resposta
  útil continuam. Se sobraria corpo vazio e não há recibo real, devolve indisponibilidade.
- Página e literal podem estar em bolhas diferentes, inclusive chamadas separadas
  de `send_message` no mesmo job. O envio atual resolve sua página pelos recibos
  desse job. Nova chamada com corpo diferente também é conferida; somente corpo
  idêntico já registrado segue diretamente para a conciliação do ledger nativo.
- Se há repetição, retira apenas o literal configurado. Pergunta, resposta nova,
  página e condições particulares fora dele permanecem no corpo.

## Limites explícitos

O escopo mínimo é página exata + literal + conversa. Uma mudança comercial invisível
por trás da mesma URL não reinicia a regra; não há identidade de produto/condição
histórica adicional. Outra página ou outro literal não é suprimido. A regra não
remove explicações novas sobre produto ou condição.

Sem consulta de oferta válida no turno, não há identificação confiável de página:
o caminho segue o legado. Histórico sem ligação ao ledger também não é prova para
esta regra. Uma intenção sem mensagem/corpo persistido não permite identificar um
literal; o ledger continua responsável por reconciliar essa intenção.

Mídia, prévia e retomada de recibos do próprio job preservam seus caminhos existentes.
O programa não passa a controlar a publicação da Marina nem ativa acompanhamentos.
A trilha de guardrails conserva o texto que avaliou; o log T5 registra que o
fechamento foi removido e seu motivo, sem copiar conteúdo ou dados da pessoa.

## Prova desta fatia

27 casos em `tests/unit/c01-matricula-uma-vez.test.ts`: primeira página, aceite,
entrega/leitura, estados pendentes, falha confirmada, bolhas separadas, chamada do
literal sem URL, vídeo auxiliar, página nova, replay, URL sem consulta, fragmentos
do literal, erro de leitura, escopo SQL, OFF e recibo real da supressão integral.
Fixtures fictícias; zero API, envio real ou IA paga. SQL inspecionado e parâmetros
conferidos por dublê; esta prova não executa consulta em banco real. Um cenário
de dois turnos usa o divisor real e comprova duas páginas, uma matrícula e a
pergunta nova preservada nas mensagens físicas fictícias.

Passaram também os 20 casos adjacentes de origem da oferta e divisão de mensagens,
o lint dos arquivos novos e `git diff --check`. A revisão independente é separada
destas provas do autor.

O release precisa da revisão independente, portões da versão e configuração
relida antes de se anunciar a capacidade como habilitada. O literal vigente a
configurar é o do texto aprovado; esta mudança não aprova P4.

### Correções da revisão independente

A revisão reproduziu dois bloqueadores: exclusão indiscriminada do job atual e
leitura só da primeira ocorrência do literal, mesmo quando falhava. Ambos foram
corrigidos. Quatro testes nasceram vermelhos (dois status na segunda ocorrência,
nova chamada no mesmo job e client do before-send) e passaram após a correção.
As 27 provas T5, as 3 provas de transação e mais 32 casos adjacentes de
estilo, espera fora do lock, classificador e liberação de conexão passaram nesta
rodada. Nenhum teste precisou afrouxar a expectativa do envio.
A leitura falhada também comprova rollback até o SAVEPOINT e liberação dele antes
de continuar; nenhum segredo da falha entra no log.

O pool retido foi tratado neste caminho novo. Isso não corrige os usos legados de
outras conexões pelo transporte dentro do lock, descritos no teste de transação
existente. A integração final e seus portões permanecem com a sessão principal.

A última checagem geral de tipos (`tsc --noEmit --incremental false -p
tsconfig.typecheck.json`, 8 GiB) terminou com o erro de tipo conhecido na fixture
A5 (`dados-externos-perfil-c01.test.ts:34`). A coordenação já corrigiu essa fixture
no main, commit `52d00bcaf`; não foi alterada nesta branch T5. Portanto esta
execução não está aprovada: o portão integrado confirmará a árvore final.
