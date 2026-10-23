# Atendimento humano e retorno combinado — candidata de 22/10/2026

Estado: **implementado e testado em ambiente isolado; não publicado nem liberado para enviar**.
Destino: núcleo (retornos) e extensão C01 (distribuição de casos). Não altera tabelas, índices, funções SQL nem migrations. A configuração dos novos rascunhos permanece com `callback_enabled: false`; liberar envios depende da integração da política de acompanhamento e dos aceites da operação.

## Quando a pessoa muda o horário

Exemplo fictício: Ana pediu retorno na sexta às 10h, depois pediu sábado às 14h. A ferramenta encontra o retorno vivo, informa o seu ID e aceita `replace_pending_id` junto da nova data. A mudança atualiza **o mesmo job**. Só a resposta de sucesso permite confirmar o novo horário; cancelar e criar em duas chamadas continua proibido.

O contrato existe nos dois caminhos:

- `schedule_followup` do motor: recebe `replace_pending_id`, devolve `pending_changed` quando a troca não venceu e `outside_send_window` quando a faixa não permite aquele horário.
- `crm_schedule_followup` do MCP/CRM: mesmo campo opcional; devolve `retorno_alterado` ou `horario_nao_permitido` nesses casos. A capacidade continua diferente de reservar um compromisso na agenda de uma atendente.

A ponte do agente declara `replace_pending_id` como retorno do contato do turno. Antes de chamar o handler, consulta `cron_jobs` com organização, contato, ID, `kind=at` e `job_kind=followup_turn`. Um ID alheio, inexistente ou de outro tipo recebe a mesma recusa, sem revelar se existe. Lista, objeto ou falha de consulta também não passam. O adaptador mantém sua conferência própria dentro da trava.

Ambos chamam `agendaRetorno`. Os adaptadores reais seguram a mesma trava por organização e contato durante a consulta e a gravação. O PostgreSQL usa a conexão retida; o Supabase usa essa conexão para reter a trava e aborta a escrita HTTP se ela cair. Duas primeiras criações simultâneas não fazem dois agendamentos. Quem encontra a trava ocupada recebe recusa e não pode anunciar sucesso. Não há alteração nos outros mecanismos de acompanhamento.

A troca também exige que o job continue ativo, na mesma organização e pessoa, com o horário lido. Se o scheduler, um cancelamento ou outra edição vencer, não recria o retorno. O payload mantém a conversa e a fronteira do atendimento. O histórico registra o horário anterior e o novo somente depois da gravação.

O adaptador de produção precisa de PostgreSQL com sessão retida; uma conexão via pooler em modo transação não atende esse contrato. A aplicação usa `getRequestPool`/`createPool`, com timeout de query e keepalive. Falha ao obter ou confirmar a conexão impede a decisão.

## Horário e configuração publicada

O instante precisa incluir data, hora e fuso. A faixa vem de `followup.send_window` na versão publicada e do fuso da organização; o exemplo aprovado é 08h–21h, com fim exclusivo. Valida antes e depois do pequeno deslocamento do scheduler. Configuração declarada e inválida impede criar o retorno.

Retornos novos do agente carregam `callback_agent_id`, obtido pelo runtime. Ao acordar, consultam a versão publicada atual: pausa, arquivamento, modo assistido, falta do agente ou `callback_enabled: false` impedem o turno. Fora da faixa, adiam a mesma reentrada para a próxima abertura. Retornos legados sem esse vínculo conservam o contrato anterior; não há desligamento global nem disparo retroativo.

**Limite de liberação:** esta prova cobre criação, reagendamento e início do turno. Não comprova sozinha a verificação financeira ou o instante físico de envio depois da resposta da IA. Os callbacks novos ficam desligados até a guarda final da política cobrir essas condições. Não apresentar esta candidata como acompanhamento comercial ativo.

## Distribuição com mais de 200 casos

Antes, o desempate lia só 200 atribuições recentes e consultas `in` cresciam com a base. Agora:

- casos abertos, membros elegíveis e histórico percorrem páginas por chave ordenada;
- os IDs das consultas relacionadas seguem em lotes de 50;
- cada leitura e escrita mantém o filtro da organização;
- uma trava retida por organização abrange leitura de carga, escolha e atribuição;
- um pedido concorrente espera a nova tentativa do evento, sem escolher com a mesma carga antiga;
- negócio que já tem dona continua com ela; sem atendente elegível, não inventa responsável;
- a gravação do dono continua condicional a `owner_user_id` vazio.

A trava libera a conexão ao terminar; queda aborta os efeitos HTTP pendentes, e incerteza no desbloqueio descarta a conexão. O cálculo lê o histórico completo: evita truncamento, mas seu custo cresce com o volume. Não cria agregação ou tabela própria.

## Três responsabilidades distintas

| Ação | Efeito preservado | O que não se deve inferir |
|---|---|---|
| Atribuir a dona do negócio | Define quem cuida daquela venda e da pendência | Não assume a conversa nem desliga a Marina |
| Responder internamente ao caso | Dá uma solução para a Marina continuar pelo fluxo do caso | Não é mensagem manual da atendente ao cliente |
| Assumir a conversa | Troca a condução para a pessoa e invalida o trabalho automático anterior pela fronteira do atendimento | Não equivale a apenas atribuir o card |

A revisão preservou as correções C2 já existentes de seleção do negócio e visibilidade do caso sem negócio. Não há novo envio de aviso: os testes usam capturas simuladas. A prova com as contas reais das atendentes e suas notificações permanece um aceite separado.

## Provas executadas

Sem IA paga, sem dados reais e sem mensagens a pessoas:

- 139 verificações em nove arquivos: retorno compartilhado, ferramenta nativa, MCP, trava, atribuição C01, assumir conversa, rotas de casos, janela de callback e reentrada.
- 6 provas com PostgreSQL local isolado: oito primeiras criações simultâneas; pool de uma conexão com fronteira de atendimento ativa; duas trocas concorrentes; cancelamento e isolamento de organização; scheduler ganhando a corrida; trava retida durante o efeito e independente entre organizações.
- A distribuição inclui 1.105 casos, limitação simulada de resposta do servidor, lote máximo de IDs, duas solicitações simultâneas, responsável anterior e ausência de atendente elegível.
- O teste SQL monta somente uma tabela sintética no banco de teste. Não é a prova completa do baseline, das permissões RLS ou da interface.

Comandos reproduzíveis:

```sh
pnpm vitest run lib/followup/retorno.test.ts lib/agent-engine/agent/schedule-followup.test.ts tests/unit/mcp-retencao-tools.test.ts lib/escalacao/trava-da-distribuicao.test.ts tests/unit/c01-caso-para-atendente.test.ts tests/unit/assumir-interrompe-turno.test.ts tests/unit/ai-cases-routes.test.ts lib/agent-engine/agent/callback-disparo.test.ts lib/agent-engine/agent/followup-turn.test.ts
# Apenas um PostgreSQL de teste local, com usuário habilitado a criar schema sintético:
TEST_DB_PORT=55439 C01_TEST_DB_USER="$USER" pnpm vitest run --config vitest.c01-retorno.config.mts
NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck
```

A suíte completa e a revisão independente ficam na integração da candidata. O primeiro typecheck com heap padrão terminou por falta de memória; a repetição com 8 GB passou, depois de corrigir o tipo da configuração de janela.

## Implantação e retorno

Estas mudanças moram no código do Deskcomm e exigem versão C01 pelos portões normais. Não são configuração que possa entrar só pela API, nem reinstalação isolada do porteiro. Não estreiam um método novo de publicação. Voltar o programa não restaura o banco nem apaga contatos. Como o payload é aditivo, o código anterior ignora os campos novos; isso também retira as garantias novas de janela e concorrência, portanto os rascunhos permanecem desligados na volta.

A sessão integradora deve atualizar o inventário C01, a história de retorno combinado, o roteiro da equipe e a evidência do guia. Não marcar um procedimento de tela como aprovado apenas por estes testes de código.


### Correção encontrada pelo portão integrado

O parâmetro de troca havia entrado na ferramenta sem entrar no contrato declarativo de escopo da ponte. O adaptador já limitava a atualização ao contato e à organização, mas faltava a recusa anterior ao handler. A declaração `replace_pending_id: "retorno"` passou a usar a guarda real existente. Foram acrescentados casos de outro contato, outra organização, outro tipo de cron, ID inexistente, lista/objeto e erro de consulta. A prova também cobre o próprio contato e o caminho sem turno, preservando o contrato do integrador.

Prova da correção: 215 verificações passaram em sete arquivos de escopo, ponte e retorno; lint dos dois arquivos de código/teste e `git diff --check` passaram. Não repetiu a suíte completa, que pertence ao portão da integração.
