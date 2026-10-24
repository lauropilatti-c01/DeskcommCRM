---
impacto: nada_mudou
secao: corrigido
titulo: Pedido de despacho da entrada conserva uma origem por mensagem
---

O caminho da entrada Meta relê a mensagem e conserva a identidade do pedido de
resposta, inclusive no replay após perda da confirmação do banco. A fila existente
continua deduplicando pelo mesmo evento. Origem anterior ambígua não cria outro
pedido. Nenhum recuperador automático, envio ou alteração de banco foi adicionado.
