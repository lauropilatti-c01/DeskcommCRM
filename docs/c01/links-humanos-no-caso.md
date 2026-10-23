# URL da resposta humana no caso (G3)

A resposta interna de uma atendente pode trazer uma URL que ainda não está na base. O agente pode repassar essa URL exata ao cliente do caso. Isso não autoriza outros caminhos do site, preços ou confirmação de pagamento.

## Contrato

- O handler transporta a referência `caseId/action/body`. Ela, sozinha, não é evidência.
- Antes de usar a referência, o turno relê o caso, a conversa, o job persistido e o último evento `human_replied`. Organização, contato, conversa, caso, ação e corpo precisam coincidir.
- Só vale evento com `actor_kind=human` e `actor_user_id` identificado. A rota autenticada de resposta ao caso já grava o evento e o job na mesma transação.
- `resolved` vale quando o caso está resolvido; `need_lead_info`, quando aguarda o cliente. Assumir/escalar, cancelar e reabrir não produzem essa autorização. Uma nova transição posterior à resposta invalida o job antigo, mesmo que o caso volte a ter o mesmo status.
- A resposta precisa preceder a criação do job. Comparamos os horários no Postgres, preservando microssegundos. Não procuramos no histórico uma resposta antiga que coincida com o payload.
- Somente as URLs extraídas entram nos conjuntos existentes `urlsDaBase` e `urlsDaConsulta`. O corpo nunca é passado a `registrarConsulta`: essa função também extrai valores monetários.
- As duas travas mantêm o normalizador já existente: caminho, parâmetros, fragmento e porta continuam relevantes. Não acrescentamos domínio à lista de domínios liberados.
- Ausência de evidência não autoriza a URL; falha de leitura não desliga as travas. As proteções de recusa, atendimento humano, janela, preço e escrita financeira continuam independentes.

## Prova e limite

Os testes próprios são `tests/unit/c01-links-da-resposta-do-caso.test.ts` e `tests/unit/c01-reentrada-do-caso-tem-origem.test.ts`. Exercitam o leitor com banco simulado, os dois gates reais e o handler com o modelo substituído. Incluem URL literal, variantes de domínio/caminho/parâmetro/fragmento, outro caso/contato/organização, corpo concorrente, ator incorreto, reabertura e proteção financeira. Nenhuma IA ou mensagem real é chamada.

O SQL não foi executado contra o laboratório compartilhado nesta fatia. A raiz executou independentemente os 38 casos e conferiu a integração no turno. O portão do release integrado continua necessário. Esta documentação descreve a capacidade candidata; não comprova sua publicação nem libera disparos.

O ponto de integração fica em `inbound-turn.ts`: `AgentTurnInput.respostaDoCaso`, chamada a `lerLinksDaRespostaDoCaso` apenas em `case_reply_turn`, preenchimento dos dois conjuntos de URLs e nenhuma alteração nos conjuntos de valores/textos afirmáveis. O patch foi integrado no turno pela sessão coordenadora após o acompanhamento de vídeo, preservando suas nove linhas de captura de origem.
