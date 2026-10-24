# Integração financeira candidata — 23/10/2026

Estado: implementação candidata concluída e provas focadas locais aprovadas.
**Desligada por padrão, sem instalação, credenciais de produção ou ativação.**
Não houve DDL, envio a lead, cobrança, estorno nem gasto de IA. A observação de
compras já instalada não muda de papel e não é autoridade deste escritor.

Esta entrega sucede o núcleo de [22/10](compra-verificada-2210.md). A API recebe
uma referência de transação; ela mesma relê a fonte autorizada. Não recebe um
booleano de pagamento, produto, identidade ou organização do chamador.

## Caminho implementado

`POST /api/v1/integrations/financial/confirm`, em runtime Node, exige Bearer
exclusivo da integração. A exceção do proxy é ancorada nesse caminho exato; não
autoriza subrotas e não substitui a autenticação do handler. Cookie do CRM e
credencial MCP não conferem esse poder. O corpo estrito contém somente:

```json
{
  "integration_id": "guru-c01",
  "transaction_id": "referencia-da-transacao",
  "lead_id": "11111111-1111-4111-8111-111111111111"
}
```

A organização vem da configuração do servidor vinculada ao hash da credencial.
Lead de outra empresa é recusado antes de consultar a fonte. A rota respeita a
guarda de suporte, não expõe erro remoto e registra auditoria apenas ao aplicar.
Repetição relê a fonte e devolve o recibo anterior, sem repetir os efeitos.

O núcleo `lib/leads/compra-verificada.ts` mantém uma única transação PostgreSQL
para recibo em `orders`, vínculo, Ganho e cancelamentos comerciais identificados.
Mantém dono do card, comando humano da conversa e lembretes de acesso intactos.
Usa a conexão retida e a trava `callback:<organização>:<contato>`. A transação
financeira é serializada pela tupla **provedor + conta + transação**, independente
do nome ou da rotação da credencial. Uma segunda integração não consegue consumir
a mesma compra para outro negócio. Recibos do formato candidato anterior também
são detectados; divergência segue para revisão.

### Identidade estável até o commit — candidata de 24/10

Depois do GET financeiro e de iniciar a transação com os timeouts existentes,
o escritor adquire `SHARE ROW EXCLUSIVE` em `public.contacts`, antes da trava
da transação financeira e dos locks de linhas. Assim, outro cadastro não pode
reivindicar por INSERT ou UPDATE o telefone/e-mail da prova entre a consulta
de identidade e o commit. O índice único sozinho não resolve o caso em que
esse identificador ainda está ausente no contato original. Uma identidade
cruzada que já existe ao adquirir a trava continua recusada para revisão.

A trava é da tabela inteira, inclusive outras organizações; leituras comuns
continuam livres. Não há GET externo com essa trava retida. Contenção expira
com `lock_timeout` de cinco segundos, e o rollback preserva negócio, recibo e
acompanhamentos. Uma nova tentativa relê a fonte. A ordem reduz inversões entre
confirmadores, mas não é prova universal de ausência de deadlock com qualquer
outro escritor; erro de lock não confirma compra. Alteração posterior ao commit
não é impedida permanentemente: a próxima execução, inclusive replay, reconfere
a identidade atual. Não houve mudança de schema nem ativação da integração.

Sete regressões foram acrescentadas ao arquivo financeiro existente: cruzamento
por telefone/e-mail durante o GET; INSERT/UPDATE retidos até o commit nos dois
sentidos; escritor anterior, timeout sem efeitos, nova tentativa e replay. Sem
a correção, cinco casos falharam e os dois controles passaram. Com a correção,
os 67 casos do arquivo passaram no baseline integral descartável. A espera foi
observada por `pg_locks` usando conexões independentes, sem esperar a escrita
concorrente dentro da barreira que retém a compra.
O revisor independente repetiu os 67 casos no mesmo baseline, todos aprovados,
e conferiu os hashes do runtime e dos testes antes/depois. A revisão libera a
integração do código desligado; não aprova a configuração financeira real nem
substitui o portão completo da árvore integrada.

## Adaptadores de leitura

Adendo candidato de 23/10: [confirmação de quitação integral no Asaas](boleto-asaas-2310.md).
O produtor pode gravar líquido em `amount_paid`; o leitor opcional novo confere
o bruto atual por cobrança, preserva datas sem horário e não muda a definição
comercial da entrada. Sem a configuração opcional, conserva o leitor descrito
abaixo e sua limitação. Não houve ativação nesta implementação.

`lib/leads/fontes-financeiras.ts` realiza exclusivamente **GET autenticado**, com
redirecionamento recusado, sem cache, cancelamento, limite de resposta e uma nova
tentativa em falha transitória. Um Retry-After que não cabe no prazo conserva a
pendência. A guarda final limita a consulta a oito segundos. Erro, timeout,
paginação malformada ou teto atingido nunca produzem ausência de compra.

- **Guru:** `GET transactions/<id>`. Exige status pago, valor e moeda, data real de
  confirmação e data do pedido. `transaction.product.id` é o ID do marketplace
  presente na transação; não é o UUID do catálogo. Oferta usa ID exato.
  Cancelamento com confirmação anterior, reembolso, chargeback, múltiplos itens
  ou gratuidade exigem revisão. O telefone nacional com DDD 55 recebe o país 55
  corretamente, sem confundir os dois códigos.
- **Boleto:** leitura PostgREST de `orders`, `customers`, `products` e `payments`,
  restrita à organização de origem. Só a soma integral de valores realmente
  pagos, com datas reais, produz prova. Pagamento parcial, manual, reembolso,
  cliente anonimizado ou organizações divergentes não confirmam. Telefone
  nacional salvo pelo checkout é normalizado com país 55. Não há fallback de
  `amount_paid` para valor previsto nem de `paid_at` para criação/atualização.

Os contratos foram confrontados com os leitores existentes do Guru e com o
schema/código do boleto. A primeira bateria usou respostas sintéticas. Depois,
foram feitas consultas **GET reais**, sem chamar a rota de confirmação:

- Guru: uma transação conhecida retornou pagamento válido, com produto e oferta
  coincidentes com o mapa exato; HTTP 200 em 552 ms, às 08h53 de 23/10.
- Boleto: a transação conhecida retornou HTTP 200 e identidade/produto coerentes,
  mas uma parcela marcada paga não tinha `amount_paid`. Não houve confirmação
  financeira nem fallback para valor previsto. Depois da correção de
  classificação, a mesma resposta voltou como revisão em 323 ms, às 08h55.
  Quatro referências do espelho foram inspecionadas ao todo: nenhuma comprovou
  pagamento integral pelos critérios desta integração. O espelho é uma pista
  para localizar a referência; sua classificação não substitui o recibo real.

Recibo incompleto de uma pessoa identificada conserva a revisão dessa pessoa,
sem tornar indisponível a conferência de todos os demais clientes. A prova de
boleto real nesta rodada é de leitura e recusa correta; **não** é uma aprovação
real do caminho positivo de pagamento integral.

## Consulta que alimenta a guarda dos acompanhamentos

`lib/leads/fonte-financeira.ts` exporta:

```ts
lerSituacaoFinanceira({
  db, organizationId, contactId, leadId, productKey, now, signal
})
// { status, checkedAt, complete, reason, evidenceHash? }
```

`db` é a conexão já retida pelo chamador. A função não obtém outra conexão nem
outra trava. Os estados são `confirmado`, `revisao`, `indisponivel` e
`nao_comprou_confirmado`. Só o último, com `complete: true`, oferece a negativa
financeira delimitada necessária à guarda; os demais impedem o envio comercial.

O instante de consulta deve ser atual: mais de 60 segundos de atraso ou mais
de 5 segundos no futuro conserva indisponibilidade. Para afirmar ausência,
exige as duas fontes configuradas e ligadas, mapa exato
do produto e plano, identidade única e apenas uma oportunidade aberta. Não usa
etiqueta, campo `pagamento_confirmado`, Ganho ou espelho SQLite como prova.
Confere também quando telefone e e-mail da transação apontam para pessoas
diferentes no CRM. Divergências conhecidas retornam motivo de revisão.

No Guru, percorre semanas desde a criação da oportunidade até a consulta, por
**data do pedido e data da confirmação**, deduplicando transações por ID. Assim,
um pedido antigo pago agora aparece pela confirmação e vai para revisão; não é
atribuído à oportunidade nova nem tratado como ausência. Janelas próximas do
limite de 5 mil são subdivididas; um dia ainda saturado é recusado. No boleto,
percorre os pedidos da conta sem limite inicial por criação, incluindo parcelas
pagas agora de pedidos anteriores. O teto de requisições e o timeout conservam
`indisponivel` se não for possível concluir.

A negativa é sobre a identidade conhecida, produto/oferta e período consultado;
não afirma que a pessoa jamais comprou em outro cadastro ou conta. Não aplica o
filtro legado de R$ 100. Pedido antigo do mesmo produto retornado na consulta,
produto sem mapa, parcial, conflito de identidade e fonte incompleta permanecem
pendências visíveis. Não inventa aliases nem reconcilia por nomes semelhantes.

## Proteções dos caminhos comuns

`save_to` de follow-up não pode escrever `pagamento_confirmado`, tanto no caminho
PostgreSQL quanto no Supabase. A mesma convenção reservada já protege IA, MCP,
formulário e atualizações comuns. Funis que exigem a confirmação continuam
recusando Ganho por arrasto, encerramento, movimento em lote e ferramentas
comuns, mesmo que alguém apresente um booleano legado. Arquivar etapa para uma
etapa terminal já era recusado pelo domínio; a prova foi acrescentada sem
substituir essa regra.

Não há nova política RLS ou restrição de banco nesta entrega. As proteções são
nos caminhos da aplicação: não se afirma proteção contra SQL direto ou escrita
PostgREST fora desses caminhos. A guarda comercial exige a fonte financeira
independentemente do estado gravado no card.

## Configuração e ativação separadas

`C01_FINANCIAL_INTEGRATIONS_JSON` é um array validado por Zod. Ausente ou com
`enabled: false`, nenhuma fonte é consultada e a rota responde desligada. Cada
entrada contém `integrationId`, `organizationId`, `provider`, `sourceAccountId`,
`tokenSha256`, `receiptSigningKey`, `baseUrl`, `apiToken`, `enabled` e `products`.
Cada produto declara os IDs exatos de origem e oferta, as chaves canônicas do
CRM e `commercialFlowIds`. Segredos ficam exclusivamente no ambiente privado do
servidor; nunca entram no catálogo do guia ou no frontend.

Foi preparada configuração privada OFF em `~/workspace/dados/crm-financeiro-2310`,
fora do Git, diretório 700 e arquivos 600. Passou pelo mesmo validador Zod da
aplicação. Contém duas fontes e os dois pares produto/plano com evidência exata
nas oportunidades atuais; não inventa mapa para os demais cards. Os IDs de
fluxos comerciais estão vazios, aguardando conferir a implantação coordenada.
`guru-c01-principal` é namespace estável da credencial C01 na configuração,
não uma alegação de ID de conta retornado pela API. O manifesto registra hashes
das fontes e das configurações, horários, limites e nenhuma ativação. Credenciais
e referências financeiras não foram copiadas para este documento.

Antes de ativar são necessários: instalar a candidata pela janela aprovada;
provisionar credenciais de leitura e assinatura; conferir o mapa de origem e o
conjunto de contas; validar uma transação conhecida e suas permissões reais;
integrar a guarda no emissor comercial e o contrato real de callbacks. Não se
ativa uma sequência apenas porque o escritor foi instalado. O clique de
ativação continua reservado ao Lauro conforme o plano aprovado.

Callback cancelável precisa de `scope: commercial`, `lead_id` e `product_key`.
Fluxo cancelável precisa estar nos IDs comerciais mapeados. O núcleo não torna
seguro, sozinho, um emissor que ignore esses contratos ou a trava compartilhada.
Não encerra como Perdido quando a conferência de compras estiver incompleta.

## Provas desta rodada

- **68 testes unitários passaram** na cobertura combinada dos três arquivos afetados: adaptadores,
  persistência da resposta e arquivamento de etapa. Cobrem DDD 55, campos
  financeiros reservados, cancelamento, parcial, resposta incompleta, repetição
  transitória, timeout e origem divergente.
- **55 cenários SQL passaram** em `tests/invariants/c01-compra-verificada.test.ts`:
  núcleo, handler real `POST(Request)` com autenticação e adaptadores Guru/boleto,
  tenant, replay, rotação de integração, quatro falhas entre efeitos, conservação
  do atendimento humano, consulta de ausência com as duas fontes e recusas.
  Apenas transporte remoto, auditoria, guarda de suporte e obtenção do pool são
  substituídos no harness; o código de conciliação e as consultas/escritas usam
  PostgreSQL real. Não equivale a navegar por uma implantação Next publicada.
- **Verificação independente aprovada no baseline integral PostgreSQL 15 com
  pgvector.** A primeira execução aprovou 52 casos e revelou uma fixture
  incoerente: `coletando` exige um roteiro de atendimento, cuja superfície é
  imutável. A fixture passou a criar o pointer correto desde o início. O
  verificador aprovou esse caso e o novo caso de relógio antigo, depois os 13
  casos da guarda financeira afetados pela validação do horário. A cobertura
  combinada inicial é de 54 cenários sem falha remanescente. A consulta real
  acrescentou o caso de recibo incompleto, executado isoladamente pelo
  verificador no mesmo baseline: aprovado, totalizando 55 cenários. Não se desabilitou trigger
  nem se alterou o baseline para fazer o teste passar. Os logs privados estão
  no diretório de evidências `crm-operacao-2310-p2`, arquivos
  `financeiro-integral-final.log`, `financeiro-integral-correcao.log` e
  `financeiro-integral-guarda-final.log` e `financeiro-integral-recibo-incompleto.log`.
- A rodada preliminar no recorte PostgreSQL de 22/10 passou; a prova integral
  acima substitui a limitação daquele recorte para estes cenários. Não é uma
  prova de publicação de produção. As consultas GET reais limitadas estão
  descritas acima.
- Lint dos arquivos alterados: zero erros, um aviso preexistente de importação
  de tipo no teste da rota de etapas. Diff-check passou. O typecheck geral
  ultrapassou o heap padrão de 4 GiB; o coordenador o executará na árvore
  integrada com memória suficiente. Não é anunciado como aprovado nesta rodada.

Repetir em um banco **descartável local** com o baseline completo já aplicado:

```sh
C01_FINANCIAL_TEST_DATABASE_URL=postgresql://<usuario>@127.0.0.1:<porta>/<banco> \
  pnpm exec vitest run --config vitest.c01-financeiro.config.mts
```

O arquivo de testes também integra `pnpm test:db`. O portão completo e a revisão
independente pertencem à árvore integrada, sem repetir suítes por precaução.
