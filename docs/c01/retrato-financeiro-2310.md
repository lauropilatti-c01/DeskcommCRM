# Retrato financeiro restrito — candidato de 23/10

Estado: código local para revisão. Não publicado, sem token real criado e sem
mudança de banco. Não altera a regra de pagamento nem o conjunto da Marina.

## Contrato e autoridade

`GET /api/v1/integrations/financial/snapshot` serve o executor de compras fora
do Deskcomm. A organização vem exclusivamente do token nativo em `api_tokens`.
A rota exige exatamente `financial:snapshot:read` e `role:viewer`. Tokens
administrativos/MCP, cookie isolado, token vencido/revogado ou empresa suspensa
não autorizam essa leitura. A chave de confirmação financeira é outra.

O token de leitura não herda `mcp:read` nem `mcp:write`. Os testes atravessam a
rota genérica de contatos e o servidor MCP real em memória: busca de pessoas,
negócios e conversas são recusadas antes do acesso às tabelas. O catálogo inteiro
é conferido para garantir que nenhuma ferramenta aceite o escopo financeiro.

Provisionamento usa `POST /api/v1/settings/api-tokens`, já existente, em sessão
administrativa autorizada, com `expires_in_days` explícito. Consumidor recebe
somente o token resultante, nunca cookie administrativo nem senha do banco.
Expiração/revogação e última utilização usam o contrato nativo. O endpoint não
aceita organização, filtro ou paginação no pedido.

## Dados e completude

- Pessoas: ID, organização, telefone e e-mail.
- Negócios: ID, organização, pessoa, estado, criação e somente os campos
  `produto_chave` e `plano_oferecido`; `product_keys` começa vazio e é derivado
  pelo executor a partir do mapa autorizado.
- Sem nomes, texto de conversa, notas, responsáveis ou outros campos livres.

Uma consulta SQL parametrizada lê as duas coleções em transação
`REPEATABLE READ READ ONLY`, com timeout e rollback. Organização é filtrada nas
duas tabelas; `row_security=off` faz uma conexão submetida a RLS falhar, em vez
de declarar um conjunto parcial como completo. Conexão com erro é descartada.

Até 20 mil linhas por coleção e 16 MiB. O limite + 1 detecta truncamento;
qualquer excesso recusa toda a resposta. Falha, duplicidade de ID, organização
divergente ou foto vencida também são recusadas. Duplicidade de telefone/e-mail
é preservada para o conciliador enxergar a ambiguidade. Negócios sem pessoa
continuam presentes e viram pendência no consumidor.

Resposta sem cache, erro genérico, seis leituras/minuto por token e organização
usando o limitador existente (se Redis falhar, ele limita por instância).
Telefone/e-mail transitam somente pelo HTTPS validado e pelo estado privado do
executor. Não imprimir payload ou cabeçalhos em logs.

## Consumidor e limites

No projeto de operação, `lab/compras/servidor/executor_retrato_https.py` valida
formato, organização, limite e frescor de 120 s; rejeita redirect e TLS inválido.
O perfil escolhe `snapshot_transport=https`. A opção PostgreSQL anterior
permanece disponível com credencial RO e `verify-full`, sem fallback automático.

A fotografia só propõe conciliação; `/financial/confirm` continua relendo a
fonte autoritativa antes de gravar. Esta mudança não decide se entrada paga de
boleto equivale a compra nem interpreta valor líquido como pagamento integral.
Ausência/erro preserva a revisão e não autoriza perda por silêncio ou cobrança.

## Checklist de integração

1. Entrada: autenticação nativa, `contacts` e `crm_leads` da organização do token.
2. Saída: coletor HTTPS e `executor_confirmacao.preparar` no projeto de operação.
3. Registro: `api_tokens.last_used_at`, request ID e resultado privado da rodada;
   leitura não gera evento comercial artificial.
4. Tela: token aparece na administração de tokens. Resultado de conciliação
   segue o relatório operacional já existente; esta entrega não cria painel.
5. Acesso: rota exata com Bearer; não é página de navegação para atendente.
6. Próximo passo: nenhum efeito próprio, pois é leitura. Falha mantém pendência.
7. Configuração: API/tela nativa de tokens e perfil privado do executor; falta de
   credencial recusa, nunca assume organização ou administrador.
8. IA/humano: não muda conversa, dono, casos ou ferramentas da Marina.
9. Retorno de erro: consumidor interrompe a rodada e não aplica foto antiga.
10. Mapa: `docs/architecture/retrato-financeiro.architecture.json`.

## Provas e estado da entrega

- `tests/unit/c01-financial-snapshot.test.ts`: autenticação, escopo exclusivo,
  projeção, organização, frescor, truncamento e limpeza de conexão.
- `tests/unit/c01-financial-snapshot-isolamento.test.ts`: token não alcança
  contatos genéricos nem ferramentas MCP.
- `tests/invariants/c01-financial-snapshot.test.ts`: PostgreSQL descartável real,
  isolamento entre organizações, limite e recusa de RLS parcial.
- Projeto de operação: transporte e pacote extraído com HTTPS local real,
  certificado não confiável/401 recusados, duas simulações sem POST.

A evidência final de execução fica no relatório da cópia de trabalho. Publicar
a versão, provisionar token e instalar o executor OFF são passos posteriores;
o sucesso local não os declara concluídos.
