# Consulta da projeção histórica — candidata OFF

Destino: extensão C01 opt-in. Ausente, preserva o leitor anterior; configurada e desligada/falha, não recai numa varredura demorada. Não cria DDL, serviço, conta, fonte financeira ou configuração operacional. Não altera confirmação de Ganho nem a leitura exata de L2.

`historyProjection` é opcional na entrada Guru de `C01_FINANCIAL_INTEGRATIONS_JSON`: `enabled` (false por padrão), `baseUrl` HTTPS de origem sem credencial/query/path, `apiToken`, `hmacKeyHex` (32 bytes em hexadecimal) e `scopeHash`. O hash precisa corresponder à organização, às duas contas financeiras habilitadas e ao `historyCoverage` já comprovado. Mais de duas integrações ou outro escopo fica bloqueado, não é omitido.

O cliente faz uma única leitura HTTP autenticada ao espelho existente, com HMACs de telefone/e-mail, organização, escopo e UUID da requisição. Recusa redirecionamento, resposta acima de 16 KiB, demora acima de 8 segundos, envelope diferente, idade acima de 15 minutos e resposta de outra requisição. Carrega o instante da fonte, sem renová-lo ao consultar. A resposta não contém dados pessoais em claro.

A contraparte descoberta na fonte é confrontada com os contatos não fundidos/anonimizados da organização em memória; o segredo não entra em SQL. A leitura é limitada a 20 mil contatos e falha fechada acima disso. A porta `sem_oferta` conserva a releitura de contato, oportunidade única e produto escolhido depois da consulta. O chamador mantém as próprias travas até o efeito.

A negativa exige `complete=true` e a razão `sem_compra_na_identidade_e_periodo_conferidos`; compra de qualquer produto bloqueia. Erro, identidade ambígua, boleto sem conferência autoritativa ou histórico vencido continuam indisponíveis/em revisão. Isso não é autorização de envio nem prova universal de ausência de compra em outro cadastro.

O servidor e a geração ficam no repositório de controle, `lab/compras/projecao_historica.py`, `projecao_http.py` e `projecao_cli.py`, documentados em `lab/compras/PROJECAO-HISTORICA.md`. Reutilizam SQLite e adaptadores do espelho, com marcas separadas de fonte/reconciliação. O incremental do Guru não oferece prova universal de alterações retrodatadas: não renova sozinho a negativa. A validade não pode ser ampliada para esconder uma carga demorada.

Provas sintéticas: cliente limitado/autenticado, escopo, ID/hash de requisição, contraparte no CRM, ligação real à porta L1 e preservação do instante. Percurso cruzado Python → HTTP local → TypeScript executado com credencial fictícia, duas respostas idênticas, sem canal, IA ou mudança no CRM. A medição real da fonte, o início histórico comprovado, a instalação HTTPS e a revisão independente continuam sendo requisitos separados da implementação.

```sh
pnpm exec vitest run tests/unit/c01-projecao-historica-financeira.test.ts tests/unit/c01-financeiro-sem-oferta.test.ts
pnpm typecheck
```
