---
impacto: nada_mudou
secao: corrigido
titulo: Retorno conserva a ordem exata entre oferta e consentimento
---

As consultas da oferta e do consentimento preservam os microssegundos do banco.
A própria oferta não reaparece como mensagem intermediária após arredondamento,
e uma mensagem real na mesma fração de milissegundo continua recusando o vínculo.
Uma terceira mensagem empatada com qualquer fronteira também torna a ordem
ambígua e impede o agendamento. Consentimento, assinatura, organização, contato
e conversa mantêm as mesmas exigências. Nenhum retorno é ativado pela correção.
