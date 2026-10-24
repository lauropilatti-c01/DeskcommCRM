# Espera durante a coleta financeira — candidata OFF

Estado: implementação local e provas focadas; revisão independente e integração
pendentes. Não instalada, não ativa. O contrato da projeção no repositório de
controle precisa acompanhar este consumidor. Nenhuma tabela, configuração de
produção, mensagem ou texto da Marina foi alterado.

## Problema e comportamento

A coleta histórica pode levar cerca de 12 minutos, com validade de 15 minutos
contada desde o primeiro GET. Tratar toda atualização como indisponibilidade
permanente manda o acompanhamento para revisão manual durante operação normal.
A candidata introduz uma espera limitada; não amplia os 900 segundos nem usa
uma fotografia anterior como prova atual de ausência de compra.

A fonte autenticada responde `projecao_em_coleta`, `complete=false` e nunca
`nao_comprou_confirmado` enquanto atualiza. O envelope mantém organização,
contas, escopo, identidade, hash da requisição e evidência. Acrescenta geração,
início original, último checkpoint, contador positivo e fim igual ao início
mais 900 segundos. Checkpoint parado há mais de 120 segundos não autoriza espera.
O primeiro checkpoint só prova início do trabalho, nunca ausência de compra;
o restante avança após faixas ou semanas efetivamente concluídas.

As leituras e conflitos de identidade continuam obrigatórios. Pagamento ou
pendência conhecidos durante coleta incompleta não são descartados. Falha,
expiração, identidade ambígua, assinatura inválida, estado ou escopo desconhecido
não recebem o tratamento temporário.

## Prazo e persistência

- O primeiro encontro com coleta válida grava `c01_financeiro_em_coleta` em
  `followup_enrollment_events`, com organização, inscrição e passo exatos.
  A chave idempotente preserva o primeiro prazo mesmo após nova geração.
- Reavalia em até 60 segundos, sem variação aleatória. O fim é o menor entre
  início da coleta + 900 segundos, janela original, 21h do dia e próximo limite
  do orçamento L2. A duração pode ser menor que 60 segundos junto desse fim.
- A âncora, os recibos, índices de toque e o orçamento original não mudam.
  Prazo vencido bloqueia antes de qualquer adiamento para a manhã seguinte.
- Antes da matrícula L1/L2, o job concluído guarda `c01_financial_wait` e o
  próximo instante de consulta. Essa espera interna não envia nada e termina
  no menor entre prazo original da coleta e janela da entrada. A matrícula
  preserva o `dueAt` original da política; o envio segue limitado a 08h–21h.
- Falha real ou prazo vencido tornam a candidatura anterior à matrícula uma
  omissão terminal. Depois da matrícula, mantêm `paused_manual`; recuperar a
  fonte não retoma essa pausa por conta própria.

## Fila e porta final

`EsperaFinanceiraC01Error` atravessa a camada de transporte sem virar erro comum.
O handler nativo de mensagens também preserva esse erro no último corte.
Se a linha já foi preparada, conserva `queued` e o recibo `requested`; o replay
retoma a mesma chave. O watchdog exclui mensagens vinculadas por ledger, job,
inscrição e versão ao grafo C01, nos dois cortes. Não usa uma flag solta como
prova. Oferta legada sem esse grafo conserva o comportamento anterior.

O worker e o envio inline usam `disporJobFinanceiroC01`: a mesma transação retém
trava por pessoa, inscrição e lease exato. A ponte atualiza o prazo e a fila
volta a pending, devolvendo a tentativa técnica. O nó não avança.

`BloqueioFinanceiroC01Error` pausa a inscrição e encerra o job na mesma transação,
limpando a mensagem preparada e o recibo ainda pendente. Recibo `accepted`,
mensagem enviada ou ID externo nunca são rebaixados.
Lease antigo, movimento de serviço ou falha de gravação não permitem disposição
parcial; o consumidor conserva a aquisição para recuperação. Uma fonte viva
continua sendo relida no corte de envio: esperar não autoriza o canal.

Recusa, resposta nova, humano, compra comprovada, perda de escopo e pausa vencem
a espera. Não há chamada de IA para aguardar, reconstruir mensagem ou interpretar
campos comerciais. L2 mantém sua consulta exata por produto/transação; esta
mudança não transforma a projeção por pessoa em confirmação de quitação.

## Prova focal

- PostgreSQL 15 descartável: 24 cenários no arquivo
  `tests/invariants/c01-continuacao-contextual.test.ts`, incluindo primeiro prazo
  L1, coleta → recuperação, falha, expiração, ambiguidade, lease obsoleto e nova
  geração. Jobs, motor, ponte, ledger e porta de envio reais; fonte financeira e
  canal fictícios. Nenhuma chamada paga ou mensagem real.
- Cinco arquivos de unidade afetados: 131 casos, incluindo envelope assinado,
  heartbeat, prazo absoluto, noite e fila. A mudança de tipagem da ponte aceita
  PoolClient para preservar a transação; não muda a consulta de render.
- Fonte Python no controle: coleta, consulta, retomada e protocolo HTTP com
  credenciais fictícias. Resultado exato e hashes ficam na ficha privada.
- Declaração dos escritores `next_eval_at` sem enfraquecer a guarda estrutural;
  o arquivo de continuidade grava prazo futuro, o helper financeiro só anula.

## Laço de operação e limites

Entrada: projeção HTTPS autenticada. Saída: decisão do motor e disposição atômica
no worker/inline. O evento persistido fica na timeline do dossiê existente em
`/app/ai/followups/enrollments/[id]`; o período anterior à matrícula fica no
payload do job, sem alegar uma nova tela dedicada. O motivo de pausa permanece
no estado/erro da inscrição. O mapa `followup-dossie.architecture.json` declara
fonte, motor, ponte e evento.

O feedback da falha é retenção com motivo explícito, sem mensagem e sem mover
Ganho. Um operador pode investigar pela fila/dossiê. A condição não é reparada
pela IA e não reabre inscrições pausadas. Os mecanismos nativos de lease e
recuperação continuam responsáveis por quedas do worker.

O observador ainda requer instalação e rota HTTPS restrita, credenciais,
configuração com fontes/contas/escopo exatos e rotina de coleta comprovada. A
medição de 729,953 segundos é uma rodada real, não SLA. Se outra geração demorar
900 segundos ou o checkpoint deixar de avançar, continua indisponível. Os 27
contatos do retrato privado incluíam equipe; cobertura não é autorização de
disparo. Instalação e ativação são etapas posteriores.

### Correção encontrada na revisão independente

O revisor reproduziu o catch do handler nativo convertendo o veto final em
mensagem failed genérica. O ajuste preserva o erro, fecha o resgate lateral do
watchdog e prova replay no mesmo ID pelo handler e ledger reais. Três novos
casos SQL dirigidos e 11 casos dos três arquivos unitários afetados passaram;
as fontes e o canal são fictícios. O primeiro vermelho SQL comprovou o resgate
indevido; dois outros casos tiveram o nome de sessão fictícia corrigido para
respeitar o índice único real. Nenhuma asserção foi retirada.


### Abertura somente quando existe espera financeira

O cronograma pode acordar após duas horas só para calcular o alvo até 23 h.
Esse despertar não abre o prazo da coleta: o helper consulta a mesma política
com o prazo candidato e só grava `c01_financeiro_em_coleta` quando a decisão é
realmente `projecao_em_coleta`. Oferta ainda antes do seu toque também conserva
o horário original. A ordem das conferências de recibos e compra fora da coleta
permanece igual.

Qualquer prazo já persistido continua sendo lido, inclusive se a fonte mudar de
geração, falhar ou voltar pronta. Nada o apaga ou renova. Compra, atendimento
humano e recusa continuam prioritários. A correção não muda os 900 segundos da
fonte, o horário 08h–21h, a janela de 23/24 h ou a retomada manual após falha.

Regressão no arquivo SQL de continuidade: runtime real + baseline descartável,
fonte fictícia, duas horas sem evento; alvo com negativa pronta elegível;
abertura no alvo, refresh e falha sem mudança do prazo; pronta antes do limite,
expiração e os três vetos. Não representa envio pelo canal nem teste de IA.
Provas e revisão ficam na ficha privada; instalação e ativação permanecem separadas.
