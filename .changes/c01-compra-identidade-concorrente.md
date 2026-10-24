---
impacto: nada_mudou
secao: corrigido
titulo: Confirmação financeira preserva identidade até concluir a gravação
---

A integração opcional trava alterações nos contatos depois de reler o pagamento,
impedindo que outro cadastro torne a identidade ambígua antes do commit. Leituras
continuam livres; contenção da tabela expira em cinco segundos e desfaz os efeitos.
Não habilita a integração, não consulta dados reais e não muda o esquema do banco.
