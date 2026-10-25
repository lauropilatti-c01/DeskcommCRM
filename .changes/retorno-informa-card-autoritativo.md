---
impacto: nada_mudou
secao: corrigido
titulo: Retorno C01 informa o card correto para a etiqueta
---

Agendamento e remarcação C01 bem-sucedidos devolvem o identificador explícito
`crm_lead_id`, resolvido pelo servidor. Isso permite etiquetar o card correto
sem confundir o alias de contato do contexto. A guarda de escopo permanece
obrigatória, e IDs injetados no agendamento continuam recusados. O legado não
muda. Não há nova gravação ou limpeza automática de etiquetas; o cron continua
sendo a fonte do estado operativo do retorno. Nenhuma capacidade é ativada.
