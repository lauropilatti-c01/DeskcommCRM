# Candidato de acompanhamento C01 — 22/10/2026

Estado: **implementado e testado como candidato bloqueado**. Sem publicação,
ativação, envio real, teste pago ou mudança de banco. Não é uma sequência pronta
para ligar. O sincronizador de compras em observação não satisfaz esta proteção.

## Contrato para os rascunhos

Os grafos usam o schema nativo de nós, arestas e configurações. A única extensão
fica no JSON já existente:

```json
{
  "settings": {
    "max_tentativas_pergunta": 3,
    "c01_acompanhamento": {
      "version": 1,
      "kind": "cronograma",
      "activated_at": null,
      "cronograma_timing": {
        "minimum_wait_minutes": 120,
        "window_margin_minutes": 15
      }
    }
  }
}
```

Para a oferta, usar `"kind": "oferta"`, sem `cronograma_timing`. O instante de ativação continua `null`.
Não há coluna, tabela, função SQL, índice, trigger ou enum novo. Copiar/importar o
grafo conserva a configuração; o editor já preserva configurações ao salvar e o
teste do painel prova que alterar uma opção não apaga a política.

O rascunho de cronograma desenha uma espera mínima candidata de 2 h e um toque.
Ao chegar à ação, a guarda calcula e persiste o vencimento correto. Uma caixa
fixa de 23 h acordaria tarde demais nos casos que precisam antecipar para o fim
do expediente; por isso ela foi retirada do rascunho. O da oferta pode
desenhar 2 h, mais 22 h, mais 48 h, mais 96 h, com quatro ações. **As esperas do
desenho não provam a origem nem a elegibilidade:** o teto de 23 h toma a última
mensagem do cliente como referência; a cadência toma a entrega da oferta.
Inscrição manual ou varredura por silêncio, sozinha, não prova nenhum desses fatos.

## O que está ligado no código candidato

- `graph-schema.ts` aceita a política e preserva o legado sem a marca.
- `validate-publish.ts` recusa publicar um grafo C01 enquanto a integração aplicada
  não existe. O erro explica a pendência na tela de publicação.
- `engine.ts` consulta a política antes de mensagem, movimentação de card ou fim
  `exhausted`. Sem prova, grava `paused_manual`, `last_error` e um evento legível.
  O estado é o existente; o histórico explica que a retenção veio do sistema.
- `messages/_handler.ts` relê o grafo pinado no início e imediatamente antes do
  efeito no canal. Isso também alcança jobs anteriormente enfileirados e envios
  fixos, de IA e de modelo que passam pelo sink comum.
- `c01-acompanhamento.ts` decide horário, prazo, transporte, retenção ou
  encerramento com fatos já reconciliados. `c01-acompanhamento-runtime.ts` define
  a fonte interna desses fatos. **A fonte de produção devolve indisponível**;
  somente os testes injetam fatos fictícios. Não existe botão ou campo para
  declarar compras “conferidas” sem a integração.

O legado sem a marca continua no caminho anterior. A decisão de bloquear não é
gravada como `messages.status=blocked`: os estados da tabela continuam os mesmos.
O motivo vive no evento/erro do acompanhamento.

## Regras provadas com fatos fictícios

- 08h inclusive até 21h exclusive em Brasília. Na oferta, vencimento noturno
  adia para 08h; a janela de 24 h e os dados são reavaliados quando chega a hora.
- Cronograma: um toque até 23 h da última entrada, ajustado para o último minuto
  permitido antes do fechamento, respeitando a espera mínima. Oferta posterior
  substitui essa retomada. Oferta: 2 h, D+1, D+3 e D+7 desde a entrega, sem antecipar
  esses intervalos para caber no expediente.
- Resposta nova, humano, recusa, restrição, callback pendente ou outra sequência
  viva cancelam o acompanhamento incompatível.
- Consulta de compras precisa ser aplicada, completa, para a mesma organização,
  pessoa e oportunidade, com identidade unívoca e idade máxima de 15 minutos.
  Compra confirmada cancela; observação, ausência, ambiguidade ou atraso bloqueiam.
- Fora das 24 h, somente modelo aprovado e conta apta. Recusas 131049, 132015 e
  131047 são bloqueios, não entregas nem silêncio. Outros erros são falhas.
- `sent`/aceite não prova entrega. Cada bolha esperada precisa ter recibo de
  entrega/leitura; ID repetido não conta duas vezes. Recibo incerto não autoriza
  nova tentativa. Um erro persistente prevalece sobre `sent` tardio.
- Perda só após quatro toques distintos entregues e 48 h desde a última entrega,
  com nova conferência de compras e nenhuma condição de cancelamento.

## Ajuste candidato de horário — recado das 23h

**Hipótese parametrizada, desligada:** mínimo de 120 minutos desde a última
entrada **e** desde a entrega comprovada do cronograma; margem de 15 minutos
antes das 24 h. Esses valores não representam regra já ativada ou qualidade
comercial provada. O schema preserva os parâmetros no JSON e rejeita valores
inválidos. Se omitidos na política C01, a candidata usa 120/15; grafos legados
sem política C01 não mudam.

O alvo é o último minuto entre 08h e 21h, não posterior à última entrada +23h
e estritamente anterior à última entrada +24h menos a margem. A resolução é
um minuto: 20h59 é o último alvo do expediente. Se esse alvo não respeitar o
mínimo após as duas referências, a retomada fica bloqueada; não há envio imediato.
O teto de 23 h também é obrigatório na execução: o instante exato é permitido,
mas qualquer atraso além dele bloqueia, sem tolerância adicional.

| Última entrada, Brasília | Alvo candidato do cronograma |
|---|---|
| 22h54 | 20h59 do dia seguinte |
| 10h | 9h do dia seguinte |
| 8h | 20h59 do mesmo dia |
| 9h | 8h do dia seguinte |
| 21h | 20h do dia seguinte |

O horário é reavaliado na execução. No caso de 22h54, um worker que só chegar
às 21h do dia seguinte bloqueia com `janela_do_cronograma_perdida`, sem reagendar
para a manhã e sem trocar automaticamente para modelo. No caso de 10h, executar
às 9h do dia seguinte são 23 h exatas e ainda cabe; às 9h00min00,001s,
às 9h10 ou às 9h44 bloqueia, mesmo com modelo aprovado e margem restante.
A precisão do teto conserva os milissegundos da entrada; a resolução de um
minuto aplica-se apenas ao agendamento. Uma entrega de
cronograma às 20h para alguém cuja última entrada foi às 8h não permite usar
20h59: seriam apenas 59 minutos após a entrega, abaixo do mínimo candidato.

Retorno combinado cancela a sequência incompatível, sem alterar o horário
prometido. Resposta nova cancela a inscrição antiga; não reinicia silenciosamente
o relógio daquele acompanhamento.

Na oferta, os testes de 20h54 e 22h54 mantêm as duas horas e depois esperam 08h
do dia seguinte; com última entrada nesses mesmos horários, ainda cabe texto
livre. Para 6h30, o alvo de 2h continua 8h30, sem antecipar para 8h. D+1 fica
às 20h54 do dia seguinte, às 8h do segundo dia e às 8h do dia seguinte,
respectivamente. Nos três exemplos D+1 já exige modelo e conta apta; D+3 e D+7
também foram conferidos. Sem modelo, bloqueia. Oferta entregue depois de uma
entrada mais antiga pode exigir modelo até no primeiro toque: a referência da
janela continua sendo a entrada, nunca a oferta.

Prova do ajuste: os testes novos falharam antes da mudança; a entrada de 22h54
era adiada para 08h dois dias depois. O teste do motor real usa fonte fictícia
aplicada, persiste o novo `next_eval_at` e bloqueia a execução tardia sem job.
Isso não substitui implementar a fonte aplicada de produção ou provar a fila real.

## Limites que impedem a liberação

1. Implementar e provar a fonte autoritativa aplicada de compras, identidade e
   oportunidade. Não usar campos da IA ou o banco de observação como atalho.
2. Materializar a origem autenticada de cada inscrição e o vínculo entre cada
   toque, todos os seus jobs/bolhas e os recibos. O avaliador não consulta essas
   fontes sozinho. Sem isso, o candidato continua bloqueado.
3. Provar exclusividade atômica entre cadência, callback e outros caminhos, não
   apenas a leitura `anotherSequence`. O candidato não afirma ter resolvido
   concorrência global.
4. Ligar seleção/adiamento e conclusão aos fatos do evento real, incluindo o
   vencimento que muda depois do enqueue. O sink bloqueia enquanto isso; não
   existe tentativa automática nova para recibo desconhecido.
5. Executar a bateria completa na candidata, publicar pela janela combinada e
   testar com celular autorizado. Ativação continua sendo do Lauro.

Evidência da entrega inicial: 365 testes passaram em dez arquivos, incluindo os novos casos,
regressão do schema/publicação, envio fixo, revalidação de condição, sink de
mensagens e preservação da política no painel. ESLint dos arquivos alterados
passou. Typecheck e portões completos ficam para a integração da candidata; estes
resultados não provam comportamento no WhatsApp de produção.

Na primeira revisão do ajuste de horário (`4618dc2a3`): **271 testes em cinco arquivos passaram**, incluindo
44 decisões puras, o consumidor no motor, o sink, schema e publicação. ESLint dos
três arquivos TypeScript alterados passou. Os avisos existentes do Vite sobre o
carregador de configuração e do Node sobre localStorage não foram tratados como
falha nem alterados nesta frente. Sem testes pagos ou alterações em produção.

A revisão independente encontrou que o teto de 23 h limitava só o alvo e
ainda aceitava uma execução às 9h10 para entrada às 10h. A correção foi feita
com quatro contraprovas falhando antes e **50 testes do arquivo afetado passando
depois**: inclui 23 h exatas, um milissegundo depois e horários 9h10/9h44.
ESLint dos dois arquivos alterados passou. A suíte completa não foi repetida
nesta correção; o portão da candidata integrada continua sendo responsabilidade
da publicação, antes de qualquer liberação.

Comando dos testes específicos:

```sh
pnpm exec vitest run lib/followup/c01-acompanhamento.test.ts lib/followup/c01-acompanhamento-engine.test.ts tests/unit/c01-acompanhamento-sink.test.ts
```

Destino: extensão C01 dentro dos pontos existentes do núcleo. Sem a marca no
grafo, a operação comum permanece inteira. Entrada: grafo opt-in; saídas: decisão,
estado e evento do acompanhamento. Falha: bloqueia antes do canal e informa a
pendência; retomada manual não dispensa nova conferência.
