---
impacto: exige_acao
secao: corrigido
titulo: Campos do negócio distinguem leitura incompleta e confirmação financeira
---

O contexto do agente preserva mais campos declarados no funil, informa cortes e
valores vazios e recusa uma leitura que falhou. A resposta de gravação de campos
precisa conter o recibo do banco para ser apresentada como concluída.

## Requer atenção

A chave `pagamento_confirmado` fica reservada: a edição genérica do negócio e as
ferramentas da IA não podem gravá-la. Nos funis que exigem essa confirmação ao
marcar Ganho, um valor preenchido por edição comum não comprova pagamento.
O núcleo financeiro candidato ainda não tem rota nem adaptador autorizado
validado; nesses funis, o encerramento genérico como Ganho permanece bloqueado
até a integração ser concluída e validada. Isso vale também para criação direta
na etapa final e quando não é possível ler as regras do funil. Não remova a
exigência para contornar a proteção.
