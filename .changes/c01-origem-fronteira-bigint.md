---
impacto: nada_mudou
secao: corrigido
titulo: Origem entregue conserva a revisão numérica do atendimento
---

A inscrição C01 captura a fronteira canônica do atendimento na transação da
origem. Revisões bigint deixam de ser serializadas como texto, evitando o
cancelamento de uma inscrição válida no primeiro tick. A guarda continua
recusando atendimento trocado ou encerrado e números fora da faixa segura.
Nenhum fluxo é ativado e não há mudança de banco.
