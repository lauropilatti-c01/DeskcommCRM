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
      "activated_at": null
    }
  }
}
```

Para a oferta, usar `"kind": "oferta"`. O instante de ativação continua `null`.
Não há coluna, tabela, função SQL, índice, trigger ou enum novo. Copiar/importar o
grafo conserva a configuração; o editor já preserva configurações ao salvar e o
teste do painel prova que alterar uma opção não apaga a política.

O rascunho de cronograma pode desenhar uma espera e um toque. O da oferta pode
desenhar 2 h, mais 22 h, mais 48 h, mais 96 h, com quatro ações. **As esperas do
desenho não provam a origem nem a elegibilidade:** a regra de 23 h toma a última
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

- 08h inclusive até 21h exclusive em Brasília. Vencimento noturno adia para 08h;
  a janela de 24 h e os dados são reavaliados quando chega a hora.
- Cronograma: um toque a partir de 23 h da última mensagem do usuário; oferta
  posterior substitui essa retomada. Oferta: 2 h, D+1, D+3 e D+7 desde a entrega.
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

Evidência local: 365 testes passaram em dez arquivos, incluindo os novos casos,
regressão do schema/publicação, envio fixo, revalidação de condição, sink de
mensagens e preservação da política no painel. ESLint dos arquivos alterados
passou. Typecheck e portões completos ficam para a integração da candidata; estes
resultados não provam comportamento no WhatsApp de produção.

Comando dos testes específicos:

```sh
pnpm exec vitest run lib/followup/c01-acompanhamento.test.ts lib/followup/c01-acompanhamento-engine.test.ts tests/unit/c01-acompanhamento-sink.test.ts
```

Destino: extensão C01 dentro dos pontos existentes do núcleo. Sem a marca no
grafo, a operação comum permanece inteira. Entrada: grafo opt-in; saídas: decisão,
estado e evento do acompanhamento. Falha: bloqueia antes do canal e informa a
pendência; retomada manual não dispensa nova conferência.
