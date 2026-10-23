---
impacto: capacidade_nova
secao: alterado
titulo: Retornos podem mudar de horário sem criar outro agendamento
---
As ferramentas de retorno aceitam `replace_pending_id` para alterar um agendamento existente a pedido do cliente. A resposta de sucesso só vem depois da gravação; concorrência, cancelamento ou disparo do retorno impedem uma confirmação indevida. Os novos resultados de recusa são `pending_changed` e `outside_send_window` na ferramenta nativa, e `retorno_alterado` e `horario_nao_permitido` no MCP. Integrações que leem esses resultados devem tratar os novos valores.

Retornos novos vinculados ao agente verificam a faixa publicada também ao iniciar o turno. A distribuição C01 passa a consultar o histórico completo e coordenar solicitações simultâneas. Não há mudança de banco nem ativação automática de acompanhamentos.
