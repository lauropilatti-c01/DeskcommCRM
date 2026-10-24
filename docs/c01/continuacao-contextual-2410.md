# Continuação contextual e conteúdo de acompanhamentos — candidata OFF

Estado: implementado na branch de trabalho, com provas locais isoladas. Sem instalação, publicação de fluxo, inscrição de pessoa real ou envio. Textos e políticas comerciais continuam candidatos. Não muda DDL, prompt ou skills da Marina. A revisão independente aprovou a integração desligada. O portão da árvore integrada e a implantação continuam sendo passos posteriores.

## O que o servidor faz

A ferramenta `prepare_contextual_followup` é oferecida somente no turno C01 habilitado por configuração aprovada. Ela propõe pedido aberto ou encerramento/pausa/recusa/compra/humano. Para um pedido aberto, informa caminho, trecho literal, natureza e, no L1, o texto contextual preparado durante o turno atual. O modelo não recebe nem escolhe UUID: o servidor acrescenta a mensagem de entrada do turno antes de validar a proposta interna. Um ID injetado na chamada é rejeitado pelo esquema público estrito. A proposta persistida e sua assinatura continuam exigindo o UUID, conferido contra o job e a mensagem real. Não há outra chamada de modelo para escrever a retomada. `next_action` e etiquetas não dão autorização.

O fim bem-sucedido do turno grava candidatura assinada no JSON do job existente. O servidor confere organização, pessoa, conversa, oportunidade/produto, entrada, última saída, tentativa e lease. A matrícula só nasce quando o job está concluído e a saída final tem recibo comprovado. A interpretação do pedido continua sendo uma proposta do modelo: o servidor prova vínculos e vetos conservadores, não a verdade semântica da classificação. Agradecimento isolado não basta; os percursos comerciais ainda precisam validar o uso da ferramenta.

O scheduler existente descobre somente candidaturas explícitas posteriores à ativação. Mantém trava por pessoa, transação, limite de uma sequência viva e evento de deduplicação. Uma omissão terminal observada antes da matrícula fica registrada no próprio job. Outra inscrição não pode surgir apenas porque o sinal de humano ou compra desapareceu depois. Falha transitória de fonte não vira compra nem entrega.

### L1 — antes de uma oferta

Um toque, nunca antes de duas horas da entrega final, entre 08h e 21h e dentro da janela de 24 horas da entrada humana. Fora do horário, adia somente se ainda couber na janela. Não usa modelo para forçar a retomada vencida.

Exige oportunidade única e aceita produto ainda desconhecido. Também aceita produto escolhido no card: escolher a área não prova oferta enviada. A leitura financeira é sempre por pessoa/todos os produtos (`financialScope=sem_oferta`); nenhum produto artificial é criado. Uma origem de oferta já registrada nessa conversa impede L1. Compra, ambiguidade, leitura incompleta ou indisponível bloqueiam.

O grafo novo e distinto está em `docs/c01/fixtures/continuacao-contextual-off.json`, com ativação nula. O corpo do nó é um marcador técnico: o worker exige a prova assinada e nunca o envia. A rota aceita um único toque de texto, sem mídia ou movimento de funil. Nenhum rascunho anterior é substituído.

### L2 — depois de uma oferta

Exige produto exato, origem autenticada e sequência anterior cancelada por resposta. Usa os recibos da cadeia original; não os copia como novas entregas. Mantém mensagem e entrega da oferta raiz, índices restantes e prazos 2h/D+1/D+3/D+7. A resposta acrescenta uma espera mínima de duas horas; não reinicia o calendário. Se mais de um prazo já venceria, segura para revisão em vez de fazer envios acumulados.

Quatro toques usados, recibo incompleto/duplicado, erro de entrega, outra origem ou troca de versão bloqueiam. As esperas relativas do desenho não reiniciam os prazos. O fechamento financeiro da oferta continua exigindo sua própria prova; esta fatia não cria nova autorização de perda.

### Revalidação e entrega

Resposta nova, humano/caso, recusa, restrição, pausa, retorno consentido, compra e outra sequência viva impedem a retomada. Os fatos e as fontes financeiras são relidos antes do canal. O worker usa o texto preparado ou o modelo exato, sem chamada adicional de IA. Falha ou rejeição não conta como toque.

O conteúdo resolvido fica ligado ao escopo da chamada física. Na porta final, nova resolução precisa produzir exatamente o mesmo corpo/modelo. Mudança de área dentro do mesmo ramo, troca de modelo, falta de contexto ou replay fora desse caminho mantém bloqueado. Não há persistência nova para essa ligação; o job e o ledger existentes preservam deduplicação e recibos. Um watchdog sem o contexto de envio não tem licença para enviar conteúdo antigo.

`status=sent` sozinho não prova nem desmente entrega. São exigidos os timestamps de entrega/leitura, com precedência dos erros. Usa-se o maior timestamp disponível de modo conservador; ele é o registro de processamento no CRM, não promessa do horário exato em que a pessoa leu.

## A1 — cronograma consultado na fonte

`c01-cronograma-catalogo.ts` abre a conexão externa pelo acesso autenticado nativo, com organização, credencial, guarda de rede e fontes liberadas. Usa a mesma seleção de conexão canônica de A5 (`organizations.settings.c01_contextual_catalog`) e um vínculo específico do grafo.

A resolução percorre `c01.agente_enfase_detalhe` → `c01.familia_produto` → inventário `ref.familia_cargo_alias`, sistema `cronograma`, distinguindo a empresa pelo edital. A família sozinha pode mencionar material de outra empresa ou concurso; isso não autoriza A1. Fonte de publicação: `lab/canonico/canonico.sql` no controle e `scripts/simulador/publicar-ref.py` / mapa de cargo-produto no projeto da base.

- Área realmente ausente: ramo de pergunta aprovado.
- Material único da empresa e da família: nome canônico inserido no texto aprovado.
- Inventário completo sem material dessa empresa: termina sem esse toque.
- Chave incompleta, duplicidade, fonte/coluna não liberada, limite de leitura, erro ou perfil alterado: mantém para revisão, sem tratar como ausência de material.

As etiquetas `a1-enfase-com-cronograma` e `a1-area-desconhecida` são projeções em memória da consulta. Valores editados no card são ignorados. O grafo e os dois corpos precisam corresponder aos hashes da configuração. O texto é relido no worker e no corte final; nenhuma URL é inventada.

## Modelos D+1/D+3/D+7

`c01-acompanhamento-conteudo.ts` resolve cada modelo pela versão/nó/produto/conexão, ID, hash, idioma e categoria exatos. Usa o resolvedor nativo de modelos aprovados e confere o WABA/canal. Categoria reclassificada, conteúdo alterado, rejeição, variável não suportada ou vínculo ausente bloqueiam, sem cair para texto livre nem pular como entregue. Nada é enviado apenas porque a configuração contém uma etiqueta de campanha.

A versão precisa existir para preencher o vínculo exato; enquanto faltar, o caminho fica bloqueado. Esta fatia não cadastra nem aprova modelos na Meta, não resolve pagamento e não liga mensagens.

## Configuração e ordem para uma implantação posterior

1. Manter todos os opt-ins desligados e preservar os rascunhos anteriores. Instalar somente após o portão próprio da versão.
2. Aprovar políticas/textos e configurar a fonte financeira autoritativa. O leitor direto `sem_oferta` exige cobertura histórica comprovada de Guru e boleto, telefone **ou** e-mail com unicidade e conflitos cruzados. O scan integral remoto não foi provado operacional dentro de 8 segundos; a projeção histórica está em outra frente. Sem ela ou prova equivalente, L1 continua bloqueado.
3. Conferir a conexão canônica e a liberação das três fontes de A1. Montar grafo distinto/OFF e preencher os vínculos exatos de versão, nós e hashes. O GRANT de `lab/canonico/canonico.sql:804` concede ao papel `agente_leitura` somente as views `agente_*`; não inclui `familia_produto` nem `familia_cargo_alias`. É preciso conferir o usuário real da conexão e preparar acesso de leitura apropriado ou fonte equivalente autorizada antes de ligar A1. Não foi executado GRANT ou DDL nesta fatia.
4. Conferir os modelos realmente aprovados e vincular ID/hash/idioma/categoria/canal. Até isso acontecer, D+1/D+3/D+7 fora da janela não operam.
5. Releitura da configuração, prova com dados fictícios e revisão independente precedem ativação. Instalação de código não autoriza disparo nem inscrição retroativa.

## Provas locais e limites

Banco descartável PostgreSQL 15 com baseline oficial, jobs, ledger, mensagens e eventos reais; fontes financeiras e transporte fictícios, rede externa recusada. Quinze cenários SQL cobriram candidatura, recibos, dedup concorrente, vetos, cadeia L2 e motor → fila → worker → porta C01 → transporte. A proteção adicional de corpo foi repetida somente nos casos de worker afetados.

Typecheck Node 22 e ESLint dos 23 arquivos TypeScript alterados passaram. Os testes unitários cobrem contrato, assinatura/lease, política temporal, rota, modelos exatos, catálogo por empresa, desvio do motor e publicação. Incluem a regressão de área alterada dentro do mesmo ramo e falha fechada sem contexto. Testes legados afetados passaram antes do último refinamento; não se alega suíte completa da árvore final.

A prova de A1 usa o leitor e a integração reais com dialeto/autenticação externos fictícios. Não prova disponibilidade nem permissão da base real. A prova do worker não é um teste de linguagem com a Marina e não usa Meta, canal ou modelo real. Nenhum lead, valor de produção ou credencial está nos arquivos versionados.

Comandos focados:

```sh
pnpm exec vitest run lib/followup/c01-continuacao.test.ts lib/followup/c01-continuacao-turno.test.ts lib/followup/c01-continuacao-grafo.test.ts lib/followup/c01-continuacao-politica.test.ts lib/followup/c01-acompanhamento-conteudo.test.ts lib/followup/c01-cronograma-catalogo.test.ts lib/followup/c01-cronograma-engine.test.ts lib/followup/c01-publicacao.test.ts
CONFERENCIA_KIT_RELEASE=v1.86.0 pnpm test:db tests/invariants/c01-continuacao-contextual.test.ts
pnpm typecheck
```

Evidências privadas: `~/workspace/dados/deskcomm-c01/continuacao-contextual-2410/`. A revisão independente repetiu 68 unitários e 15 SQL, encontrou a ausência de proteção de conteúdo no L2 sem modelos e confirmou a correção: 4 testes da fronteira e somente o worker SQL L2 foram repetidos. O vínculo é lido da inscrição persistida e oferta legada sem vínculo permanece no caminho anterior. Typecheck e lint do ajuste passaram. Os nomes e resultados das rodadas ficam no relatório privado; a ficha não transforma o artefato em operação ativa.
