# Vínculo Pix — preparo reversível de 25/10/2026

## Atualização autorizada em 26/10, 12h08

A candidata agora lê `effectiveDate` da transação Pix remota, com GET pelo identificador da cobrança. Confere id, cobrança vinculada, status DONE, tipo CREDIT, valor bruto e ausência de estorno; mantém toda a cadeia pedido/QR/autorização/instruções e unicidade anterior. Offset explícito é preservado. Sem offset, interpreta Brasília (UTC-3), por decisão de risco do Lauro, sem afirmar que o Asaas documentou esse fuso. Data civil deve concordar com `paymentDate`; o instante continua depois do pedido e antes da consulta. Sem transação com instante, permanece a guarda diária conservadora. Datas e instantes não são misturados numa quitação.

A guarda comercial de todos os acompanhamentos reutiliza a consulta integral por identidade, inclusive projeção assinada e suas guardas de frescor/completude. Compra de outro produto bloqueia. Entrada recebida com parcelas pendentes fica em revisão e **não autoriza venda nem Ganho**; quitação integral continua sendo exigida para o recibo que marca Ganho nesta versão. Não existe mutação financeira ou DDL neste patch.

Testes focados cobrem o mesmo dia, offset explícito, timestamp inválido/anterior/futuro, transação divergente e ausência de prova; comprador de outro produto anterior à oportunidade; entrada RECEIVED relida com parcela PENDING e oportunidade aberta. A revisão e o gate completos pertencem ao coordenador antes da publicação. Histórico abaixo descreve a candidata anterior a essa autorização.

## Histórico do preparo anterior

Estado: candidata isolada em `fix/pix-vinculo-2610`, baseada em `2aca82dc` (c01.6). Não publicada, não liberada para operar. Não há migration, aprovação operacional, janela, confirmação de compra, cobrança ou envio.

## Contrato estreito

A igualdade histórica `externalReference === order.id` continua válida. O ramo novo exige exatamente uma entrada `entry_pix` e parcelas `installment_pix_automatic`, todas PIX. A entrada sem referência externa precisa ter QR remoto igual ao identificador local e ao QR da autorização. Cada parcela precisa ter referência **inteira e exata** `pix_instruction:<pedido>:<ordinal>:<vencimento>`.

GETs autenticados verificam autorização, cliente, identificador ponta a ponta e lista completa das instruções da autorização. Cada instrução DONE liga uma única cobrança à mesma autorização, cliente e vencimento. Paginação incompleta, contagem divergente, duplicação, cancelamento ou identificação vazia recusam. Consultas atuais no produtor, limitadas a dois registros e sem ocultar outra organização, conferem unicidade da autorização, de cada cobrança e do QR. Não se presume que índices de uma migration estejam aplicados.

Carteira, contrato/assinatura, organização, cliente, cobrança RECEIVED, valores brutos, total integral, ausência de estorno/manual e datas continuam obrigatórios. Autorização EXPIRED não significa pagamento desfeito nem comprova pagamento: só a cobrança recebida e todas as guardas podem produzir prova. Autorização cancelada/recusada continua em revisão.

## Limites explícitos

Não aceita entrada isolada, referência por substring, `billing_obligation`, reprogramação com vencimentos divergentes, lista parcial ou vínculo sustentado apenas pelo status local. Amplia os vínculos que o leitor pode reconhecer, mantendo quitação integral e precisão da data obrigatórias; por isso a publicação depende do OK do Lauro. A amostra real possui data de entrada sem hora no mesmo dia da criação: **continua em revisão**, mesmo com vínculo e soma comprovados. Não se inventa horário nem se aprova a ON.

Prova estrutural privada: 20 predicados positivos, 11 GETs, zero mutações. Código do produtor analisado no commit `42079b32`; versão servida do produtor não foi comprovada por essa leitura. Migrações descrevem unicidade, enquanto as consultas provam somente o estado observado. Identidades e respostas reais ficam fora do Git.

## Verificação e continuidade

Baseline64 testes; RED confirmou dois casos positivos recusados pelo leitor anterior. Com a implementação: 103 testes focados (64 anteriores +39 novos) passaram. Revisão independente executou 10 cenários próprios, inclusive falha de transporte nas novas consultas, estorno entre leituras, colisões, ausência de identificação e troca de pedido do mesmo cliente. Parecer final, hashes e logs privados em `~/workspace/dados/deskcomm-c01/preparo-pix-guru-20261026/`.

**Histórico da primeira tentativa de tipos:** `pnpm typecheck` terminou com saída 134 por falta de memória do Node (`JavaScript heap out of memory`). A parada foi registrada. Depois, por autorização explícita do Lauro, o mesmo typecheck completo rodou sozinho com `NODE_OPTIONS=--max-old-space-size=8192` e passou (saída0,14,47s, HEAD5efbaee37). Lint dos três arquivos já havia passado. Logs e comando em `typecheck-8gb/` na base privada. Nenhum código mudou para obter esse resultado.

Não é prova de release: suíte completa, ensaio de banco, volta, publicação nominal e prova no ar não foram executados nesta fatia. Publicação e ON exigem decisão do Lauro e pré-condições novas. Não reaproveitar aprovação ou janela vencida. Para abandonar a candidata basta não integrá-la: produção e `main` continuam em c01.6; a cópia fica aberta para essa decisão, sem apagar trabalho.

## Diagnóstico temporal concluído — 25/10, após23h25

Quatro GETs atuais conferiram carteira, cobrança, transação Pix e pedido. A transação está ligada à cobrança, é CREDIT/DONE, valor/QR conferem e não há estorno observado. Seu campo `effectiveDate` contém hora com segundos, mas não offset. Não confundir a precisão diária da cobrança com inexistência de hora em toda a API.

Interpretar esse horário como UTC ou como UTC-3 inverte a ordem entre pedido e pagamento. Sem contrato autoritativo do fuso, o instante não é comprovável. A documentação oficial consultada descreve a consulta por ID; o schema do produtor não estabelece offset nesse campo. **A guarda permanece, e a amostra continua em revisão.** Não substituir por criação da transação, recebimento de webhook, paid_at local ou identificador ponta a ponta.

Diagnóstico é somente leitura, sem evolução temporal implementada. Evidências privadas `data-pix/DIAGNOSTICO.md` e `DIAGNOSTICO.json`. Para outra fatia: provar fuso/instante e desenhar um caminho de leitura com testes específicos, preservando causalidade e demais guardas. Nenhum merge, tag, publicação, ON, janela, aprovação operacional, F09/áudio ou mensagem autorizado nesta continuação.

Revisão final independente:15 conferências de evidência e2 casos de mesmo dia passaram. Typecheck/log/HEAD e hashes do código confirmados; nenhum novo achado bloqueante no patch. Parecer `revisao-final/PARECER.md`: candidata e diagnóstico aprovados como preparo para decisão, mantendo guarda. Não autoriza publicação, ON nem quitação da amostra.
