---
impacto: nada_mudou
secao: corrigido
titulo: Retorno comercial recebe o consentimento vinculado pelo servidor
---

No retorno comercial C01, o modelo informa o pedido e o horário sem identificadores
internos de mensagens ou agendamentos. O servidor conserva o vínculo com o turno,
a oferta anterior e o consentimento literal. Campos internos injetados são
recusados, sem transformação silenciosa. Para mudar um retorno, a chamada precisa
primeiro observar a recusa de pendência e depois pedir a substituição explicitamente;
o identificador fica apenas no turno e o banco recusa alteração concorrente.
A confirmação ao lead continua permitida somente após o sucesso. O agendamento
legado, a assinatura e as guardas comerciais permanecem iguais. Não ativa retornos.
