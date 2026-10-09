---
impacto: nada_mudou
secao: corrigido
titulo: A falha ao recuperar respostas do formulário por recibo deixa o atendimento pendente para nova tentativa
---
Quando o formulário do piloto devolve um recibo e o serviço de recuperação falha, o agente espera a nova tentativa do mesmo atendimento antes de responder. A resposta só segue quando o serviço devolve o resumo das escolhas. Se as tentativas se esgotarem, o mecanismo existente abre um caso e passa o atendimento à equipe, com aviso ao cliente pela cadeia de envio. Os formulários anteriores e os acompanhamentos mantêm o comportamento existente. Não há configuração nova nem mudança de banco.
