# Jornadas

Módulo de consulta da entrada WhatsApp até o encaminhamento ao agente ou à equipe. A tela usa a navegação, a sessão e os componentes do CRM. Não publica nem modifica formulários, agentes, contatos ou conversas.

## Fronteiras

```mermaid
flowchart LR
  A[Equipe autenticada] --> B[/app/jornadas]
  B --> C[API do CRM: viewer + organização + módulo]
  C --> D[Leitor privado: fotografia versionada]
  D --> E[Meta: inventário e definições]
  D --> F[Configuração instalada sanitizada]
  D --> G[Catálogo canônico e agente publicado]
  C --> H[Executor de cenários isolado]
```

O leitor fica em `crm-agentico/lab/jornadas`, com instalação e ciclo de vida próprios. O atendimento não importa nenhum arquivo do módulo. Queda, lentidão ou configuração inválida do leitor afetam somente Jornadas. O leitor não recebe credenciais por pedido do navegador e não aceita organização escolhida pelo cliente.

O servidor do CRM deriva a organização da sessão em cada requisição, confere o módulo e valida a resposta pelo contrato `lib/c01/jornadas/contrato.ts`. O leitor valida novamente a organização e a autenticação interna. A fotografia não serve como autorização. O cache é privado, versionado por organização; cada fonte informa sua própria conferência e falha. Publicação de Flow, ativação operacional e cenário selecionado são informações distintas.

## Integração mínima

- `components/c01/jornadas`: apresentação e navegação local; React Flow carregado sob demanda.
- `lib/c01/jornadas`: contrato e acesso ao leitor.
- `app/app/jornadas`: página com proteção no servidor.
- `app/api/v1/c01/jornadas`: leitura, atualização da fotografia e cenários.
- Catálogo único de navegação, módulos opcionais e recursos opcionais: entrada registrada; nenhuma lista paralela de páginas.
- `MODULO_C01_JORNADAS` em `platform_config`: mecanismo de configuração existente, desligado por padrão. Nenhuma migration própria.

`C01_JORNADAS_URL` e `C01_JORNADAS_SECRET` são configuração exclusiva do servidor. O segredo precisa de pelo menos 32 caracteres. Não usar `NEXT_PUBLIC_` nem expor o serviço no proxy público. A configuração inválida resulta em indisponibilidade do módulo, sem interromper a inicialização do CRM.

## Cenários

A solicitação fixa `snapshot_id` e `flow_id` e leva as respostas cumulativas. A conferência roda sem credenciais, rede, sessão real, envio de WhatsApp ou chamadas de IA. Código/definição desconhecidos suspendem a equivalência; resultados não verificados são apresentados como tal. Textos fixos e saídas determinísticas podem ser percorridos; uma futura frase gerada pela Marina não é prometida pelo mapa.

## Manutenção e recuperação

Ao mudar Flows, código de entrada ou contrato, atualizar os adaptadores do leitor e os casos conhecidos. Não duplicar regras comerciais na interface. Contrato incompatível fecha a consulta com erro explícito, sem criar inventário vazio nem mostrar outra organização.

A mudança pertence ao fork privado e deve permanecer no `C01.md` e no manifesto `lab/producao/nossas-mudancas.tsv` do `crm-agentico`. Atualização do autor segue merge e os portões existentes; conflito nestes pontos exige revalidação da navegação, permissões e contrato.

Falha exclusiva: desligar o módulo e parar o leitor/executor. O atendimento permanece independente. Regressão geral: procedimento versionado de retorno do programa, com prova de compatibilidade. Nunca apagar sessões/recibos, parar o motor de formulários ou modificar o agente para recuperar esta tela.

## Evidência exigida

Contrato e organização, módulo desligado inclusive por URL direta, perda de acesso, fonte indisponível/desatualizada, cenário fixado à versão, campos/opções reais e navegação por teclado. Prova visual em desktop e 375 px; leitura real na instalação liberada, sem dados pessoais em fixtures. A suíte E2E padrão tem limpeza de canais: usar bancada exclusiva ou configuração de leitura sem teardown para não tocar o laboratório compartilhado.
