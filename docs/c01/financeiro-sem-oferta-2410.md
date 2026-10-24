# Consulta financeira antes da oferta — candidata de 24/10

Destino: extensão C01, OFF enquanto a configuração e o consumidor L1 não estiverem
liberados. Arestas: fontes autenticadas Guru/boleto →
`lerSituacaoFinanceiraSemOferta` → guarda de continuação
`lib/followup/c01-continuacao-runtime.ts`, entregue pela frente F04. Não muda a
consulta exata de L2 nem a confirmação de Ganho. Não tem DDL ou escrita financeira.

## Contrato

A chamada recebe banco, organização, contato, oportunidade, `productKey:null`,
`finalidade:"sem_oferta"`, instante recente e sinal de cancelamento. Devolve o
contrato existente `SituacaoFinanceira`. Só `nao_comprou_confirmado`, com
`complete:true`, evidência e recência aceitas pelo chamador, pode permitir L1.
`confirmado` significa que encontrou compra, não que gravou Ganho.

- Oportunidade única e aberta, contato ativo. O produto pode já ter sido escolhido
  no formulário; `productKey:null` elimina o filtro da consulta, não exige um card
  vazio. O consumidor comprova ausência de oferta pela origem comercial. Todas as
  consultas SQL filtram a organização; não se escolhe o card mais recente.
- Telefone internacional **ou** e-mail, conforme o contrato de identidade existente;
  exclusividade no CRM e concordância nos registros financeiros encontrados. A
  varredura integral Guru contém telefone e não depende de pesquisa por e-mail.
  A contraparte descoberta nas fontes é usada em memória para verificar conflitos
  anteriores e posteriores; não é gravada no contato. Mesmo telefone em e-mails
  incompatíveis (ou o inverso) permanece revisão. A negativa descreve somente a
  identidade e o período conferidos, nunca ausência universal de compra.
- Guru e boleto habilitados, com leitura completa. Guru percorre desde a origem
  comprovada da conta, em semanas, por pedido e confirmação, com deduplicação,
  repetição limitada e corte de janelas grandes pelo leitor existente. Boleto
  pagina todos os pedidos até o instante consultado. Nenhum filtro por produto,
  oferta, valor mínimo ou data de criação da negociação limita essa consulta.
- Qualquer compra paga encontrada bloqueia, inclusive produto antigo e valor
  abaixo de R$ 100. Gratuidade comprovada no Guru ganha apenas um indicador de
  ausência de pagamento; continua incapaz de produzir recibo/Ganho. Pendência
  sem confirmação não equivale a compra. Reembolso, parcial, baixa manual,
  conflito e estado desconhecido permanecem revisão.
- Um pedido boleto encontrado exige a conferência Asaas existente. Seu espelho
  local pendente, sem essa prova, não certifica ausência de recebimento. O leitor
  atual também mantém cobrança sem quitação ou vínculo completo em revisão;
  **esta fatia não amplia os estados negativos aceitos do Asaas**. Ausência de
  pedidos só vale depois da paginação autenticada integral do boleto.
- Depois dos GETs, identidade e oportunidade são relidas. Mudança observada
  invalida a prova. Não há trava global de contatos durante rede nem snapshot
  distribuído entre fornecedores. A proteção final do envio e a corrida com
  resposta/compra/humano pertencem ao chamador no ponto do efeito.

## O mínimo que falta para operar

Na configuração financeira Guru existente, o bloco opcional é:

```json
{
  "historyCoverage": {
    "startedAt": "<início integral da conta em ISO UTC>",
    "evidenceHash": "<sha256 da ficha privada que comprova a cobertura>"
  }
}
```

A ficha precisa vincular organização, conta de origem, início de operação e
escopo completo. O hash é uma referência auditável: **não prova a cobertura por
si só**. Não preencher com a primeira venda encontrada, início da oportunidade,
24 meses arbitrários ou hash inventado. Sem ficha revisada não se ativa a
configuração. Este campo não é exigido por confirmações de transação existentes.

A varredura continua com prazo total de 8 segundos e teto de 512 páginas/chamadas
lógicas; exceder o prazo/limite é indisponibilidade. O desempenho de um histórico
real inteiro ainda precisa ser medido. Não ampliar prazo dentro da guarda de
envio nem fingir que uma carga parcial ficou completa. Uma projeção local
comprovadamente completa e recente pode ser necessária depois dessa medição;
o cache atual de 24 meses/R$ 100 não satisfaz este contrato automaticamente.

Não se exige coleta nova de e-mail de quem já tem telefone. Ausência dos dois
identificadores ou conflito real permanece revisão. Se já houver informação em
formulário/conversa ou fonte autenticada, pode-se conciliá-la por um vínculo
inequívoco, sem inventar dado. Esta peça não adiciona pergunta comercial nem
escreve no contato. O recorte atual e as contagens de cobertura ficam na ficha
privada; **implementado não significa disponível para os leads atuais**.

## Provas e limites

Fixtures sintéticas exercitam ausência nas duas fontes, compra anterior de outro
produto/baixo valor, gratuidade, pendência, histórico incompleto, conflitos e
mudanças de identidade durante rede, boleto sem prova, cursor inválido, erro e
cancelamento. O RED comportamental teve 20 falhas; a reconferência acrescentada
teve quatro falhas antes da correção. Regressões do leitor e contrato aceito são
rodadas junto do novo arquivo. Na candidata final, 46 casos novos e 25 do leitor passaram (71/71); a rodada
anterior dos quatro arquivos passou 152/152. Tipagem Node 22/heap 8 GB, lint
focado e conferência de fragmento passaram. A revisão do consumidor F04 encontrou e corrigiu a distinção entre produto
escolhido e oferta enviada: o produto inicial é preservado na releitura, mas não
impede a consulta. A conclusão da mesma revisão fica na ficha da entrega.

Sem API financeira real, IA, envio, instalação, configuração ou leitura de
conversa nesta implementação. As provas unitárias usam transporte e banco
fictícios; não provam latência, cobertura histórica real, ativação L1 ou corrida
comercial de ponta a ponta. Não houve mudança em `fonte-financeira.ts` nem em
`compra-verificada.ts`.

Continuidade: é leitura pura, sem evento ou tela próprios. O consumidor F04 usa
`status/reason` para registrar o bloqueio no recibo/fila operacional existente;
se essa integração não existir, a função isolada não está entregue como operação.
Falha devolve motivo e impede envio; resolver a fonte/identidade permite nova
consulta, sem mudança automática no cadastro.

```sh
pnpm exec vitest run tests/unit/c01-financeiro-sem-oferta.test.ts tests/unit/c01-fontes-financeiras.test.ts tests/unit/c01-boleto-asaas-liquidacao.test.ts tests/unit/c01-boleto-contrato-aceito.test.ts
NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck
pnpm exec eslint lib/leads/fonte-financeira-sem-oferta.ts lib/leads/configuracao-financeira.ts lib/leads/fontes-financeiras.ts tests/unit/c01-financeiro-sem-oferta.test.ts
```
