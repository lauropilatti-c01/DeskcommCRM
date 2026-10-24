# Origem entregue conserva a fronteira numérica do atendimento

Estado: correção candidata, sem ativação nem instalação. A guarda de atendimento, o parser e o pool PostgreSQL não mudaram.

## Defeito reproduzido

No baseline real, `conversations.service_revision` e `demandas.revision` são `bigint`. O driver `pg` devolve esses valores como strings. O registro da origem entregava essas strings ao JSON de `service_boundary`; a leitura canônica pela RPC devolvia números. O primeiro tick cancelava uma inscrição válida como atendimento encerrado ou substituído, antes de criar o job.

A reprodução usou a mensagem de origem pelo handler real, confirmação de entrega pelo webhook HTTP e cron real com PostgreSQL e PostgREST descartáveis. A conversa continuava aberta e os IDs eram iguais; as revisões eram `"1"` no registro e `1` na leitura canônica.

## Correção

A origem lê `public.fn_service_boundary` na mesma transação, depois de travar a conversa. Valida o parser estrito, organização, contato, conversa, demanda e estado antes de inserir. Inteiro fora da faixa segura é recusado. O retry não reconstrói a identidade e o consumidor mantém a guarda original: troca ou encerramento continuam vetando o efeito.

A fixture reduzida de `c01-acompanhamento-runtime` agora usa `bigint` e um adapter explícito da leitura canônica no schema descartável daquele arquivo. A nova regressão `c01-origem-fronteira-bigint` usa o baseline e a função SQL reais, sem esse adapter.

## Prova local

- Quatro regressões no baseline real: demanda presente/ausente, replay, revisão insegura, demanda encerrada e trocada, conversa encerrada.
- 29 controles existentes do runtime aprovados.
- Sete percursos privados da integração: vídeo aos 15 min, oferta após 2 h, cronograma no limite calculado de 23 h; resposta, compra, humano e recusa cancelando sem reaparecer no replay. O consumidor separado registrou worker, PID e lease; nova instância não reenviou o job concluído.

A rodada conjunta aprovou 34 testes em três arquivos (90,66 s); um teste percorre os sete caminhos. O pacote privado conserva os scripts, recibos e logs em `~/workspace/dados/deskcomm-c01/relogio-integracao-c015-2410/`.

## Limites da integração

As rotas reais rodaram em servidor HTTP da fixture; não houve Next/cron instalado nem relógio de produção alterado. O consumidor separado usou o laço nativo, claim, handler, fronteira, ledger e conclusão reais; não representa o daemon inteiro do servidor. A aceleração materializou somente vencimentos de inscrições fictícias já atingidos no relógio local, com antes/depois registrado. Nenhum job consumido foi reescrito.

Transporte e fonte financeira foram fictícios, sem IA nem rede externa. `accepted` só virou `delivered` após callback fictício atravessar o webhook real. A passagem humana usou a RPC real com membro fictício; autenticação e tela pertencem às provas anteriores. Somente `activated_at` dos grafos recebeu data de fixture; seus períodos e textos foram preservados.

Não é prova de ativação, publicação ou funcionamento de serviço instalado. A integração final, o portão da candidata, a versão servida e os rascunhos OFF continuam com a sessão integradora.
