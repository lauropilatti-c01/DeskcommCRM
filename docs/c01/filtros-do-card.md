# Perfil do card na busca de vídeos — A5

Candidata de 23/10/2026, desligada por padrão. Cobre somente `c01.agente_videos_canal`, não todas as consultas comerciais nem a seção de gravação de campos da Marina.

## Contrato

A organização pode definir `settings.c01_contextual_catalog` como `{ "enabled": true, "connection_id": "<uuid-da-conexao>" }`. A configuração não é criada por esta entrega. Ausência ou OFF conserva a consulta anterior. Só a conexão efetivamente resolvida e autorizada e a view exata recebem a intervenção; chamadas fora de uma conversa continuam no contrato do MCP.

O servidor usa organização e contato fornecidos pelo motor do turno. Relê o card pela mesma regra já usada no contexto da Marina, inclusive o card fechado mais recente quando não existe aberto. Não recebe ID de contato, ID de card ou perfil dos argumentos do modelo. Card ambíguo/ausente ou erro de leitura impede a consulta contextual, sem usar dados inventados.

- O assunto continua vindo da dúvida atual: exige uma única igualdade e um dos oito assuntos conhecidos. O servidor não deduz a intenção.
- Escolaridade e empresa substituem os filtros que a IA tenha sugerido. As opções são as mesmas da view e do formulário. Campo vazio usa literalmente `não sei`; valor inválido é recusado.
- Inscrição `Sim` tenta primeiro `so_inscrito_tp2026 = true`. Somente após sucesso sem linhas repete a consulta retirando essa preferência. Conserva assunto, escolaridade, empresa, demais filtros e o filtro de isolamento do cliente. Erro não produz repetição nem catálogo amplo.
- Com `Não`, `Não sabe` ou ausência de inscrição não inventa inscrição nem acrescenta a preferência, como o manual vigente.
- O limite contextual é no máximo 20 linhas, respeitando o teto menor da conexão. Fontes/colunas/permissões e conferência de tipos permanecem no conector comum.
- A resposta sinaliza apenas que o perfil foi aplicado e se houve retirada da preferência de inscrição. Não devolve dados pessoais novos nem os registra no log.

## Prova

Teste primeiro: sete cenários falharam antes da implementação; seis de preservação já passavam. Após implementar, 13 novos e 37 do conector anterior passaram. A revisão independente repetiu os 50 casos e conferiu a origem do contexto, o acesso à conexão, os enums SQL e o comportamento do manual §9. Typecheck passou; nenhum CRM, provedor de IA ou banco real foi chamado.

Arquivos: `lib/external-db/c01-perfil-do-card.ts`, `lib/mcp/tools/dados-externos.ts` e `lib/mcp/tools/dados-externos-perfil-c01.test.ts`.

## Entrega e limites

Implementado e testado em fixtures, sem configuração ou publicação. A prova integrada e a releitura da configuração na instalação ainda são necessárias. Só depois dessa prova a sessão comercial pode retirar o manual correspondente do prompt; esta frente não altera o texto nem as skills. Não há migration/DDL.

### Integração do typecheck

A compilação de outra cópia encontrou um tipo amplo demais no helper do teste
(`FiltroDeLeitura.valor` aceita `unknown`, ao contrário da entrada validada da
ferramenta). O helper passou a usar o tipo real do argumento do handler, sem
cast nem alteração de runtime. Os 13 casos foram repetidos e passaram.
A prova de tipos que vale para a entrega será a da árvore integrada final.
