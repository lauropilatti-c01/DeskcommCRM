# Boleto: prova de quitação integral — candidata de 23/10/2026

**Evolução candidata em 24/10:** o contrato de valor descrito abaixo foi ampliado
em [condições aceitas e total financiado](boleto-contrato-aceito-2410.md). A
comparação com `orders.total_value` foi substituída pela conferência do snapshot
e do fingerprint do contrato assinado. Ausência dessa prova fica em revisão.
As regras de carteira, identidade, referência, recebimento, data e OFF continuam.
O resultado de 23/10 abaixo é histórico; não prova a candidata de 24/10.

Implementação opt-in, ainda sem instalação ou leitura real nesta rodada. O executor
financeiro continua desligado; esta mudança não publica nem confirma compras na
produção. Não há DDL. A decisão de considerar uma entrada como Ganho continua
separada: liberar acesso após a entrada não equivale a aprovar essa definição.

## Contrato

O produtor do boleto grava o líquido recebido em `payments.amount_paid`. Esse
valor não pode ser comparado ao contrato bruto para decidir quitação. Com
`asaasSettlement.enabled=true`, o leitor consulta a cobrança atual no Asaas por
`payments.asaas_payment_id`, sem procurar por nome, valor ou telefone aproximado.

1. O GET `/v3/wallets/` precisa devolver uma única carteira, igual ao `walletId`
   privado. Carteira divergente, incompleta ou inacessível bloqueia a consulta.
2. Cada GET `/v3/payments/<id>` exige ID exato, cliente igual ao
   `customers.external_customer_id_asaas` e `externalReference` igual ao pedido.
   As parcelas locais precisam pertencer ao mesmo pedido e à mesma organização.
3. Só `RECEIVED`, com tipo `BOLETO` ou `PIX`, fornece bruto liquidado. O `value`
   atual precisa coincidir com a parcela contratada; o `netValue` pode ser menor
   por taxa. Somar o valor previsto local sozinho não produz prova.
4. Todas as cobranças precisam estar resolvidas e a soma do bruto precisa ser
   exatamente `orders.total_value`. Entrada parcial fica em revisão. `CONFIRMED`
   ainda não é liquidação; baixa manual, estorno, chargeback, juros/desconto ou
   valor original divergente não são aceitos automaticamente.
5. IDs repetidos, cobrança sem ID canônico, referência alternativa, identidade
   incompleta e status duvidoso ficam em revisão. O leitor não deduz o vínculo.
   O escritor mantém as verificações de identidade única, produto, oferta e
   oportunidade correta antes de gravar Ganho ou cancelar acompanhamento.

A leitura atual pode superar um espelho local atrasado (`pending` ou líquido e
data ausentes) quando todos os vínculos e recebimentos estiverem comprovados no
provedor. Uma marca local de baixa manual, disputa ou estorno continua impedindo
confirmação automática. Falha de transporte nunca vira ausência de compra.

## Data sem horário

O contrato oficial informa `paymentDate` como `date`. O recibo conserva, por
exemplo, `paidAt: "2026-10-20"` e `paidAtPrecision: "day"`, sem atribuir meia-noite.
Guru e recibos anteriores continuam usando o instante que já tinham.

Como o contrato consultado não especifica o fuso dessa data, a comparação usa um
envelope de todos os fusos civis (±14 h). Esse intervalo serve apenas à prova e
nunca é gravado como horário do pagamento. Cada recebimento tem de ser posterior
ao pedido em todo o intervalo possível, e todo o intervalo deve anteceder a
observação. O escritor reconfere isso e que o pedido pertence ao período da
oportunidade. A data e sua precisão entram na assinatura e no replay do recibo.

Exemplo suficiente: pedido em 18/10, pagamento informado em 20/10 e consulta em
23/10. Exemplo que exige revisão: pedido e pagamento informados no mesmo dia.
Essa cautela também pode adiar a confirmação de uma cobrança recém-liquidada.
Não bloqueia toda data sem horário; bloqueia a ambiguidade temporal concreta.

## Configuração privada, sem mudança de banco

Na entrada `provider: "boleto"` de `C01_FINANCIAL_INTEGRATIONS_JSON`, o campo
opcional `asaasSettlement` contém apenas:

```json
{
  "enabled": false,
  "environment": "production",
  "walletId": "33333333-3333-4333-8333-333333333333",
  "apiToken": "<credencial-privada-somente-leitura>"
}
```

Permissões necessárias: `PAYMENT:READ` e `ACCOUNT_INFO:READ`. Os dois hosts são
fechados no código: `api.asaas.com` e `api-sandbox.asaas.com`; não há URL, método,
corpo ou operação financeira configurável. Há somente GET, sem redirecionamento,
sem cache, com limite de resposta e prazo total de seis segundos para o Asaas,
subordinado também ao cancelamento do chamador. Erros não expõem resposta nem
credencial. Conta ou ambiente não são descobertos por tentativa.

Sem o bloco ou com `enabled=false`, o Asaas não é consultado e a leitura anterior
é preservada. Isso preserva compatibilidade, **não corrige retroativamente a
limitação líquido/bruto desse leitor anterior**. A configuração de toda a
integração e o executor continuam dependendo da habilitação já existente.
Esta entrega não os habilita. Para recuar a candidata, desabilitar o bloco e
manter executor OFF; não usar o modo anterior como prova de quitação pendente.

O caminho novo não emite negativa para um pedido existente não resolvido: retorna
revisão. A guarda dos acompanhamentos mantém envio/perda impedidos nessa situação.
A cobertura continua limitada aos identificadores exatos conhecidos. Cobrança em
outro cadastro não é reconciliada por suposição.

A guarda percorre os registros locais, mas pede confirmação Asaas somente dos
pedidos que coincidem com telefone ou e-mail da pessoa em análise. Os demais
continuam visíveis, sem recibo e como revisão; não viram negativa. Assim,
cobranças de centenas de outras pessoas não consomem o prazo dessa consulta.

## Provas e limites

Resultado em 23/10: **64/64 unitários e 60/60 invariantes**, ESLint focado e
typecheck aprovados (Node 22; typecheck com heap de 8 GB). Revisor independente
repetiu os 124 testes e aprovou mais **7/7 cenários adversariais**, incluindo
501 pedidos em duas páginas, conflito de identidade, entrada parcial, hash,
estorno na releitura e negativa com ambas as fontes completas. Parecer: aprovado
para integrar **desligado**; não é aprovação operacional nem financeira.

- Respostas sintéticas com o contrato real: taxa, soma de parcelas, parcial,
  estado local atrasado/divergente, baixa manual, estorno, identidade, carteira,
  sandbox, data inválida/ambígua, replay, HTTP, JSON, redirect e timeout.
- Invariante do escritor: data suficiente persiste como data e reexecuta sem
  duplicidade; data insuficiente não grava nem cancela. Usa banco descartável.
- A suíte completa pertence à integração da árvore final. Não houve consulta
  Asaas real, confirmação de pagamento, envio de
  mensagem ou gasto de IA nesta implementação.

Fontes oficiais:
[cobrança por ID](https://docs.asaas.com/reference/recuperar-uma-unica-cobranca),
[carteira da conta](https://docs.asaas.com/reference/recuperar-walletid),
[eventos de cobrança](https://docs.asaas.com/docs/webhook-para-cobrancas),
[baixa manual](https://docs.asaas.com/reference/confirm-cash-receipt),
[valor líquido e taxas](https://docs.asaas.com/docs/split-de-pagamentos).

Código: `liquidacao-boleto-asaas.ts`, `periodo-financeiro.ts`,
`fontes-financeiras.ts`, `configuracao-financeira.ts` e `compra-verificada.ts`,
todos em `lib/leads/`. Testes: `tests/unit/c01-boleto-asaas-liquidacao.test.ts` e
`tests/invariants/c01-compra-verificada.test.ts`.
