# Fila grande de casos

Correção candidata posterior à `v1.86.0-c01.3`. Não modifica a tag publicada, o banco, a política de acesso ou os serviços em execução.

Destino: núcleo. A correção atende a fila já existente, sem exigir uma opção
por organização. A paginação preserva as rotas e os contratos existentes;
falhas de leitura continuam retornando erro, em vez de uma lista parcial
apresentada como completa. O ajuste de navegação no celular está descrito ao fim.

A abertura da fila falhou no laboratório com `URI too long`. A leitura de visibilidade enumerava conversas num único filtro `IN`; a consulta privilegiada repetia a lista para dados e contador. Além disso, consultas sem paginação dependiam do teto implícito de 1.000 linhas do PostgREST.

`lib/escalacao/chamados.ts` passa a:

- Paginar os identificadores dos casos em blocos de 200, com ordem estável por ID.
- Consultar a visibilidade das conversas no cliente de sessão em lotes de 100 UUIDs. Um erro em qualquer lote recusa a operação inteira, antes da criação do cliente admin pela rota.
- Consultar dados/contagem com o mesmo recorte de organização e de conversas, sem duplicar IDs. Cada lote também pagina os casos; uma conversa com mais de mil casos não é cortada.
- Unir resultados na ordem `opened_at DESC, id DESC`, preservando microssegundos. O limite pedido vale para o conjunto final. O contador exato de abertos independe do estado e do limite pedidos para a lista.
- Manter `todas` somente para o chamador que o declara explicitamente, como o MCP. Conjunto vazio não consulta dados privilegiados; argumento ausente continua sendo erro.

O caso individual continua restrito ao ID pedido. Não se troca a RLS por uma regra de papel em TypeScript. Leituras de várias páginas não formam um snapshot de banco único; alterações concorrentes na fila podem exigir atualização da tela, como em outras listas paginadas. Não há uma página pública nova nem alteração de API.

## Prova focada

```sh
pnpm exec vitest run tests/unit/chamados-paginacao.test.ts tests/unit/chamados-visibilidade.test.ts tests/unit/ai-cases-routes.test.ts
pnpm typecheck
```

A fixture usa o cliente Supabase real com HTTP fictício, limita a URL a 8 KB e cada resposta a 1.000 linhas. Antes da correção, oito cenários reprovaram; depois passaram 47 testes nos três arquivos, incluindo:

- 1.250 candidatas e subconjunto da sessão, 210 conversas e 1.250 casos de uma única conversa.
- Outro tenant e conversa oculta excluídos; IDs repetidos, empates, diferença de um microssegundo e limite global.
- Filtro fechado com contador de abertos; limite zero; MCP explícito.
- Falha no segundo lote de RLS, numa página posterior ou no contador. A rota falha sem criar o cliente admin quando a autorização está incompleta.

Na retomada de 23/10 às 23h10, a tipagem do fixture foi corrigida sem casts nem
mudança das asserções. O arquivo de paginação e o gate dos fragmentos passaram
em 27 testes; `pnpm typecheck` passou com Node 22 e teto de 8 GB. Logs locais:
`/tmp/c01-casos-retomada-focados-2310.log` e
`/tmp/c01-casos-retomada-typecheck-2310.log`.

## Revisão independente HTTP/RLS

Aprovada, sem impeditivos. O revisor repetiu os 47 testes focados e executou
dez cenários em PostgreSQL 15.19 e PostgREST 14.8 reais, duas vezes, com
resultados idênticos. Cada rodada fez 115 requisições; a maior URI teve
4.285 bytes. RLS ativa em `conversations` e `agent_cases`, com JWT fictício
`authenticated` de usuário com papel `agent`.

A prova confirmou o recorte de 416 entre 1.250 conversas, isolamento de outra
organização, histórico de 1.250 casos da mesma conversa, contagem, limite global,
empates e microssegundos comparados ao SQL. Erros persistentes de uma página,
do segundo lote de visibilidade e do contador não viraram resultado parcial.
Relatório privado: `~/workspace/dados/deskcomm-c01/casos-http-2310/REVISAO.md`.
SHA-256 do helper revisado:
`d9df0e7c0dde505368003aff54b52602e7e6e14a08629b4f9bca98d1392b58ba`.

Limites: autenticação por JWT fictício, sem GoTrue/cookie; helpers reais por
HTTP/PostgREST, sem o handler Next completo, cuja recusa anterior ao admin tem
teste unitário separado. Os erros negativos são injetados. Não é benchmark
nem prova de snapshot único entre páginas. Nenhum teste usa produção, envia
mensagem ou consome IA. O portão completo, a troca do laboratório e a prova da
tela na candidata final ficam com a integração.

## Detalhe do caso no celular

Na prova da tela da candidata `944257f58`, a lista abriu com 238 casos, mas a
seleção manteve duas colunas em 375 px. A caixa de resposta ficou fora da tela:
posição horizontal de 376 px e largura de 34 px. O mesmo defeito foi reproduzido
na cópia isolada antes da correção.

`CaseList.tsx` segue o padrão responsivo do Inbox: abaixo do ponto `md`, exibe
a lista ou o detalhe conforme a seleção. O botão Voltar aparece assim que um
caso está selecionado, inclusive enquanto a API carrega. Voltar limpa somente
a seleção; conserva a aba aberta. No computador, as duas colunas permanecem.
Permissões, chamadas da API e envio de respostas não mudam.

Prova focada da correção:

- Os 12 testes de `case-list`, `case-detail` e
  `caso-tem-tipo-da-rota-ate-a-tela` passaram. O novo teste de navegação falhou
  antes da correção, pela ausência de Voltar. A fixture de projeção recebeu
  apenas o método `range`, exigido pela paginação; as asserções não mudaram.
- Navegador em 375 × 812: detalhe sem rolagem horizontal, resposta em
  `x=57`, com 261 px de largura; Voltar reexibe os 238 casos, e é possível
  abrir outro caso.
- Navegador em 1.440 × 1.000: lista e detalhe visíveis juntos, botão Voltar
  oculto, resposta com 726 px de largura e documento sem excesso horizontal.
- `pnpm typecheck` passou com Node 22 e teto de 8 GB; ESLint nos três arquivos
  de código alterados teve zero erros e um aviso preexistente de import não
  usado. Os 19 testes dos fragmentos de release passaram.

A revisão independente aprovou a integração, sem impeditivos. Além de repetir
a navegação nas duas larguras, reteve um GET para comprovar Voltar durante o
carregamento e conferiu que a aba Concluídos permanece selecionada. Os seis
testes dos dois arquivos alterados passaram novamente. Relatório privado:
`~/workspace/dados/deskcomm-c01/casos-mobile-2310/REVISAO-INDEPENDENTE.md`.
SHA-256 do `CaseList.tsx` revisado:
`4e7dff9c8e9008d2f837c6c4afd1d7805fed7703eb6f5967906b67d4a8d22afd`.

Capturas e medidas ficam fora do git, em
`~/workspace/dados/deskcomm-c01/casos-mobile-2310/`. A prova usa a sessão real
do laboratório numa aplicação Next isolada; não envia resposta nem altera
casos. A primeira navegação atualizou automaticamente a presença da conta de
teste; depois disso, métodos de escrita da API foram bloqueados no navegador.
Não comprova entrega de mensagem, desempenho da fila nem a versão publicada.
A sessão usada na prova visual é administrativa; a prova RLS com papel de
atendente é a HTTP documentada acima. A integração continua responsável pelo
portão completo e pela liberação.
