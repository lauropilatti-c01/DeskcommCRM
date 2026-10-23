# Compra verificada — núcleo candidato de 22/10/2026

Estado: implementado e testado localmente, **desligado, sem rota e sem ferramenta
registrada**. Não foi instalado nem acionado na produção. A integração
observacional continua apenas conferindo. Não há migration, tabela ou coluna
própria; o núcleo usa estruturas já existentes na versão do autor.

## O que está implementado

`lib/leads/compra-verificada.ts` recebe somente credencial, ID da transação e ID
do negócio. Organização, conta de origem, provedor, mapa de produtos e adaptador
são configuração exclusiva do servidor. Ausência de `enabled: true`, credencial
incorreta ou ausência do adaptador recusam a chamada antes da fonte financeira.
A credencial é comparada com seu SHA-256 em tempo constante e é separada do MCP
e da chave que assina recibos.

O adaptador obrigatório deve reler a transação na API autorizada da conta. O
núcleo não aceita o JSON enviado pelo cliente nem o espelho de compras como
prova. Exige estado pago, valor total confirmado, moeda, pedido e pagamento com
datas coerentes, consulta feita há no máximo 60 segundos e limite de oito
segundos para a leitura. Consulta que falha não equivale a ausência de compra.

Depois da leitura, ele:

1. Retém a mesma conexão e a trava `callback:<organização>:<contato>`, usada pelo
   retorno combinado. Outra confirmação para o mesmo contato é recusada como
   ocupada e pode tentar novamente. Também serializa o ID da transação na conta.
2. Relê negócio, contato, funil e etapa. Exige produto e oferta por ID no mapa
   autorizado e chaves canônicas idênticas no negócio. Não concilia por nome.
3. Confere telefone/e-mail: pelo menos um identificador deve coincidir, e uma
   divergência conhecida ou identidades apontando para pessoas diferentes vai
   para revisão. Não resolve automaticamente um boleto pago por outra pessoa.
4. Recusa pedido anterior à criação da oportunidade, mesmo que o pagamento seja
   recente. Recusa negócio encerrado, mais de uma oportunidade aberta e campos
   obrigatórios ausentes. Apenas a exigência financeira reservada é satisfeita
   por esta prova; as demais exigências e a lista de motivos de Ganho continuam.
5. Em **uma transação**, grava `orders.external`, vínculo em `crm_lead_links`,
   confirmação no negócio, etapa Ganho e cancelamentos comerciais identificados.
   O trigger existente do autor escreve o status final. Falha em qualquer passo
   desfaz todos. Dono do card e comando da conversa não são alterados.

O recibo fica em `orders.payload.financial_receipt`, com vínculo canônico e
assinatura HMAC. Contém hash protegido dos identificadores, sem telefone/e-mail
em texto. A origem genérica `external` já existe na migration 0623 do autor;
`external_id` recebe o prefixo da integração. A unicidade existente, a trava e a
assinatura impedem que o mesmo recibo seja reaproveitado para outro negócio.
JSON `paid` ou etiqueta não comprovam pagamento.

Uma repetição relê a fonte, confere o recibo assinado e o vínculo gravado e
retorna `replay`, sem novos efeitos. Recibo adulterado, incompleto ou com estado
incoerente é recusado. Se a conexão cair depois do COMMIT, o chamador pode não
receber sucesso; repetir a mesma transação é o caminho previsto para recuperar
o resultado. A perda real de conexão depois do COMMIT não foi provocada nesta
rodada; o replay após gravação completa foi provado.

## Cancelamento e limites que impedem ativar

Somente os IDs de fluxos enumerados em `commercialFlowIds` são comerciais para
este núcleo. Os estados vivos incluem `active`, `waiting_reply`, `dormente`,
`paused_handoff`, `paused_manual` e `coletando`. Callbacks precisam carregar
`scope: commercial`, `lead_id` e `product_key` correspondentes. Jobs pendentes
ligados a essas execuções também são cancelados, inclusive quando o cron já
disparou ou o enrollment já terminou. O histórico encerrado permanece intacto.

O `job_queue` existente não tem estado `cancelled`: o job pendente passa para
`failed` com `last_error: purchase_confirmed`. Isso é cancelamento comercial
identificado, não prova de falha de entrega nem de silêncio do cliente. A futura
fila operacional precisa apresentar esse motivo corretamente.

Lembrete do formulário e pergunta de acesso ficam fora desses seletores. Um job
em execução ou lease de acompanhamento válido impede aplicar a compra nessa
tentativa. O chamador futuro precisa reconsultar a fonte e tentar novamente.

**A corrida com envios reais não está resolvida por este núcleo sozinho.** Todo
emissor comercial terá de usar a mesma trava e reler elegibilidade imediatamente
antes do efeito. Não existe prova de cancelamento dos callbacks atuais sem os
marcadores acima: `retorno.ts` atualmente não os grava. A prova de cancelamento
usa payloads sintéticos e depende dessa ponte real futura. Esses caminhos não
classificados, a ausência de adaptadores
autorizados e de guarda final integrada mantêm a ativação bloqueada.

Também faltam, antes de qualquer uso real:

- Adaptadores Guru/boleto autenticados, conferidos contra o contrato real da
  transação. O `pago_em` legado com fallback para data de pedido/atualização não
  serve como confirmação.
- Política comprovada para parcelamento, pagamentos parciais, múltiplos itens,
  reembolso e chargeback. O núcleo recusa pagamento parcial e estado diferente
  de `paid`; não executa estorno nem reabre negócio.
- Rota interna com autenticação exclusiva, tratamento de erro/retentativa,
  observabilidade e revisão de automações disparadas pelo Ganho. Nenhuma rota
  existente de cobrança SaaS deve ser reaproveitada: ela atende outro domínio.
- Instalação e rotação segura da chave de recibos, mapa explícito por conta e
  produto, inventário dos emissores e autorização de ativação.

## Provas e como repetir

`tests/invariants/c01-compra-verificada.test.ts` contém 32 cenários: autenticação,
fonte indisponível/velha/inválida, identidade ambígua, outro tenant, produto e
pedido antigos, parcial, dois negócios abertos, recibo forjado/adulterado,
repetição, concorrência, pool com uma conexão, timeout, quatro falhas entre os
efeitos, preservação do atendimento humano e cancelamento comercial seletivo.

A execução local usou PostgreSQL 15, banco descartável exclusivo e dados
fictícios. As tabelas/constraints relevantes, os estados vigentes e o trigger de
Ganho foram extraídos do baseline do autor, com stubs de autenticação do teste.
O banco do recorte não habilita RLS; o trigger nativo incluído é o fechamento do
card, e os demais efeitos de uma instalação completa não são exercitados.
**Não foi uma instalação completa do baseline nem uma prova de RLS.** O harness
completo não iniciou porque o Docker local estava desligado. Isso é limite da
evidência, não um resultado aprovado do portão.

No ambiente com Docker, os mesmos testes usam o baseline completo pelo comando:

```sh
pnpm test:db tests/invariants/c01-compra-verificada.test.ts
```

Os 32 cenários passaram também na execução do verificador independente. Typecheck
e lint dos arquivos desta frente passaram como conferências separadas. O portão
completo da árvore integrada pertence à sessão principal. Não houve gasto de IA,
consulta de dados pessoais reais nem envio externo nesta frente.

## Integração e guia

Depende do helper `lib/agent-engine/db/trava-de-efeito.ts`, entregue pela frente
de atendimento/retorno (`611204cb8`). O helper não é reimplementado aqui. A sessão
principal deve inventariar núcleo, prova e convenção de recibo, mantendo explícito
que esta entrega é candidata. O guia deve continuar mostrando compras como
conferência observacional, sem anunciar Ganho automático ou retomadas ativas.
