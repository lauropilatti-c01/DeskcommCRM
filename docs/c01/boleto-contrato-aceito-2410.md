# Boleto: condições aceitas e total financiado — candidata de 24/10

Destino: extensão C01, dentro do leitor opt-in `asaasSettlement`. Sem essa
configuração, a operação comum continua inteira. Esta candidata não instala,
ativa, cobra, concede desconto nem confirma Ganho. Não há DDL ou migração.

## Contrato da primeira fatia

O principal (`orders.total_value`), o total financiado e o líquido recebido têm
significados diferentes. O leitor aceita o total financiado somente quando:

1. A fonte autenticada do boleto entrega `parcelamento_snapshot.schemaVersion=1`,
   regra versionada e um único contrato ClickSign assinado, ligado à organização
   e ao pedido, com documento/envelope iguais e modelo versionado. Cancelamento,
   marca de desconto posterior e cronologia impossível impedem a prova.
2. O fingerprint financeiro/identidade salvo na criação do contrato corresponde
   exatamente ao algoritmo do produtor (`src/lib/contracts/render.ts`,
   `clicksignVariablesHash`). Entram total, entrada, financiamento, juros, cupom,
   quantidade, valores e vencimentos, nome do produto, nome e CPF da pessoa.
   O valor e o tipo JSON são preservados no cálculo; não se normaliza o contrato
   para fazer um hash divergente coincidir.
   O registro local `signed` não autentica uma assinatura: o leitor exige também
   GET atual do documento exato na ClickSign, com credencial em `Authorization`,
   conta pinada por SHA-256 e ambiente correspondente. Confere documento fechado,
   modelo, signatário e assinatura com nome/CPF, checksum do arquivo e condições
   retornadas em `template.data`. Ausência ou divergência mantém revisão.
3. Principal, entrada e primeira parcela locais correspondem ao snapshot; entrada
   + financiamento + juros = total; financiamento = principal − entrada − desconto.
   Cada parcela local corresponde ao número, valor e vencimento aceitos. Não há
   tolerância de centavo, redistribuição implícita nem baixa só pela entrada.
4. Todas as cobranças continuam passando pelos GETs autenticados de carteira e
   ID canônico Asaas. Cliente, pedido, valor bruto e vencimento correspondem;
   só `RECEIVED` conta. Baixa manual, pagamento parcial, estorno, disputa,
   juros de atraso/desconto remoto e datas ambíguas mantêm as guardas anteriores.
5. A soma recebida corresponde ao total aceito. O recibo conserva esse total,
   sua evidência e a precisão `day`; nunca compara líquido com principal.

Sem snapshot, com hash vazio/legado, mudança posterior, contrato múltiplo ou
vínculo incerto, o resultado é **revisão**, nunca ausência de compra. A releitura
recalcula as condições e consulta as cobranças novamente. Guru, identidade,
paginação e isolamento financeiro não foram relaxados.

## Fonte de confiança e limites

O fingerprint, salvo ao criar o documento, **não é o hash do PDF**. A revisão
independente reproduziu que o produtor pode marcar `signed` a partir de webhook
sem HMAC quando seu segredo está ausente. Por isso o leitor não confia nesse
estado sozinho: relê o documento por GET autenticado, sem modificar o produtor.
O checksum remoto é evidência do arquivo assinado; o leitor não baixa nem valida
criptograficamente o PDF a cada consulta. A fonte de autoridade é a resposta
autenticada da ClickSign, junto das condições/fingerprint correspondentes.

O bloco opcional `asaasSettlement.clicksign` contém `apiToken` e
`accountKeySha256` (SHA-256 da chave da conta previamente conferida). Ausente =
revisão. Não há host, método ou documento arbitrário configurável: ambiente
`production` usa `app.clicksign.com` e `sandbox` usa `sandbox.clicksign.com`;
o ID vem do contrato validado. GET sem redirecionamento/cache, prazo compartilhado
com a leitura Asaas e resposta limitada. Token nunca vai em URL ou evidência.
Falha de transporte permanece indisponibilidade, não ausência de compra.

O vínculo Asaas permanece estrito: `externalReference=order.id`. Modalidades Pix
com referência ausente ou estruturada não são admitidas por mera igualdade de
cliente, valor ou ID canônico local. A modalidade de entrada dividida em mais de
uma cobrança também fica em revisão. A amostra real B, embora tenha fingerprint
e valores correspondentes, **ainda não é positiva desta implementação**. O legado
com hash vazio e diferenças de centavos permanece revisão. Não se supõe fraude
ou adulteração por falta de prova.

Os campos consultados já existem no produtor; a seleção foi ampliada somente no
CRM. Não há mudança de schema nem chave nova. A seleção não solicita token de
assinatura, URL privada do documento ou credencial ClickSign. Nenhum dado real
aparece nas fixtures ou neste documento.

## Prova e continuidade

- RED: a candidata anterior falhou em três dos 26 novos cenários, incluindo a
  alteração do principal para coincidir com o recebido. O teste positivo mede a
  integração pelo leitor real `criarFonteFinanceira`, sem chamar só o helper.
- GREEN inicial: os 26 cenários novos e os 64 anteriores passaram. As fixtures
  antigas ganharam contrato sintético e vencimento; nenhuma asserção financeira
  anterior foi retirada. Tipagem, lint e revisão independente são registrados
  na ficha privada da entrega, sem confundir o resultado inicial com aprovação.
- A revisão independente trouxe um RED real do produtor: sem HMAC, seu webhook
  marcava assinatura e o leitor aceitava. A correção exige leitura remota;
  ausência de configuração, documento não fechado, conta/condições/assinatura
  divergentes e falhas de transporte têm regressões duráveis. **114/114** casos
  focados passaram após a correção; tipagem/lint e revisão final ficam na ficha.
- Os testes usam transporte sintético. Separadamente, GETs legítimos por IDs
  existentes provaram a projeção do produtor e `Authorization` no endpoint v1;
  o código candidato validou contrato/documento da amostra B e manteve A em
  revisão. O checksum remoto B correspondeu ao PDF anteriormente lido. Não é
  prova de quitação B, de completude da fonte ou de instalação operacional.
- Sem cobrança, assinatura, Ganho, IA ou envio. A suíte completa cabe à raiz.

Comandos focados:

```sh
pnpm exec vitest run tests/unit/c01-boleto-contrato-aceito.test.ts tests/unit/c01-boleto-asaas-liquidacao.test.ts tests/unit/c01-fontes-financeiras.test.ts
pnpm exec eslint lib/leads/contrato-boleto-aceito.ts lib/leads/documento-boleto-clicksign.ts lib/leads/liquidacao-boleto-asaas.ts lib/leads/fontes-financeiras.ts tests/helpers/boleto-contrato-ficticio.ts tests/unit/c01-boleto-contrato-aceito.test.ts tests/unit/c01-boleto-asaas-liquidacao.test.ts
NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck
```

### Continuidade da peça

Entrada: snapshot GET autenticado em `fontes-financeiras.ts`; saída: prova/revisão
para `fonte-financeira.ts` e `compra-verificada.ts`. Este helper é leitura pura e
não emite atividade própria nem cria tela. O executor existente registra a
confirmação e sua atividade; a guarda comercial mantém uma pessoa com revisão
fora de envio/perda. Configuração continua no contrato financeiro existente,
desligada. Não há novo laço autônomo ou ação enquanto o caso exige revisão.

Fontes primárias: [autenticação da ClickSign](https://developers.clicksign.com/v2.0/docs/informacoes-gerais) e [documento v1, template e signatários](https://developers.clicksign.com/v1.0/docs/visualizar-documento). A documentação contém exemplos antigos com token na URL; a compatibilidade do header no GET legado foi conferida por leitura autenticada dos documentos existentes.
