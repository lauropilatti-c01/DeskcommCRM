# Vínculo Pix — preparo reversível de 25/10/2026

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

**Parada na verificação adicional de tipos:** `pnpm typecheck` terminou com saída 134 por falta de memória do Node (`JavaScript heap out of memory`). Não foi repetido nem tratado como aprovado. Lint dos três arquivos passou. A candidata fica incompleta para integração/publicação até resolver essa pendência, conforme a trava do Lauro.

Não é prova de release: suíte completa, ensaio de banco, volta, publicação nominal e prova no ar não foram executados nesta fatia. Publicação e ON exigem decisão do Lauro e pré-condições novas. Não reaproveitar aprovação ou janela vencida. Para abandonar a candidata basta não integrá-la: produção e `main` continuam em c01.6; a cópia fica aberta para essa decisão, sem apagar trabalho.
