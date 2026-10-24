---
impacto: nada_mudou
secao: corrigido
titulo: Webhook Meta não confirma mensagem que falhou antes de persistir
---

Falhas de ingestão ou de escrita de estado pedem reentrega, preservando o restante
do lote. Uma duplicata só é confirmada depois da releitura da mensagem na mesma
organização, sessão e direção. Token, assinatura, payload inválido e descartes
permanentes mantêm suas respostas anteriores.

Não altera banco, ativa envios ou promete recuperar efeitos posteriores à
persistência. O contrato e os limites estão em `docs/c01/meta-ack-persistencia-2410.md`.
