import type { Snapshot } from "@/lib/c01/jornadas/contrato";

/** Dados estritamente fictícios. Importado apenas pela bancada e pelos testes. */
export const exemplo: Snapshot = {
  schema_version: 1,
  snapshot_id: "foto-exemplo-1",
  organization_id: "00000000-0000-4000-8000-000000000001",
  environment: "example",
  captured_at: "2026-10-13T12:00:00Z",
  completeness: "partial",
  sources: [
    {
      id: "meta",
      label: "Formulários na Meta",
      status: "ok",
      checked_at: "2026-10-13T12:00:00Z",
      version: "7.3",
    },
    {
      id: "runtime",
      label: "Regras instaladas",
      status: "unknown",
      checked_at: "2026-10-13T12:00:00Z",
      message: "Versão ainda não reconhecida.",
    },
  ],
  flows: [
    {
      id: "piloto",
      name: "Qualificação com busca",
      status: "PUBLISHED",
      activation: "enabled",
      audience: "Somente os celulares de teste autorizados.",
      entry_screen: "INICIO",
      verified: true,
      definition_hash: "exemplo",
      screens: [
        {
          id: "INICIO",
          title: "Sua formação",
          texts: ["Qual é a sua formação?"],
          terminal: false,
          fields: [
            {
              name: "formacao",
              label: "Formação",
              type: "RadioButtonsGroup",
              required: true,
              dynamic: false,
              options: [
                { id: "medio", title: "Só ensino médio" },
                { id: "engenharia", title: "Engenharia" },
              ],
            },
          ],
          next: [{ target: "PLANO", label: "Só ensino médio", verified: true }],
        },
        {
          id: "PLANO",
          title: "Curso técnico",
          texts: ["Ter só o ensino médio não equivale a ter concluído um curso técnico."],
          terminal: false,
          fields: [
            {
              name: "plano",
              label: "Quer fazer um curso técnico?",
              type: "RadioButtonsGroup",
              required: true,
              dynamic: false,
              options: [
                { id: "sei", title: "Sim, já sei qual curso" },
                { id: "ajuda", title: "Quero ajuda para escolher" },
                { id: "nao", title: "Não pretendo fazer agora" },
              ],
            },
          ],
          next: [
            { target: "BUSCA", label: "Já sei qual curso", verified: true },
            { target: "FINAL", label: "Quero ajuda ou não pretendo agora", verified: false },
          ],
        },
        {
          id: "BUSCA",
          title: "Buscar seu curso",
          texts: [],
          terminal: false,
          fields: [
            {
              name: "termo",
              label: "Nome do curso",
              type: "TextInput",
              required: true,
              dynamic: false,
              options: [],
            },
          ],
          next: [{ target: "RESULTADOS", label: "Buscar", verified: true }],
        },
        {
          id: "RESULTADOS",
          title: "Cursos encontrados",
          texts: ["${data.resumo}"],
          terminal: false,
          fields: [
            {
              name: "curso",
              label: "Seu curso",
              type: "Dropdown",
              required: true,
              dynamic: true,
              options: [],
            },
          ],
          next: [{ target: "FINAL", label: "Curso escolhido", verified: true }],
        },
        {
          id: "FINAL",
          title: "Revisão das respostas",
          texts: [],
          terminal: true,
          fields: [],
          next: [],
        },
      ],
    },
    {
      id: "antigo",
      name: "Formulário anterior",
      status: "PUBLISHED",
      activation: "disabled",
      audience: "Versão anterior, preservada para recibos já enviados.",
      entry_screen: "",
      verified: false,
      definition_hash: "exemplo-antigo",
      screens: [],
    },
  ],
  graph: {
    nodes: [
      {
        id: "entrada",
        label: "Mensagem recebida",
        kind: "entry",
        detail: "Oi ou mensagem da página",
      },
      {
        id: "regra",
        label: "Qual caminho pode seguir?",
        kind: "decision",
        detail: "Público e situação da conversa",
      },
      { id: "formulario", label: "Qualificação com busca", kind: "form", flow_id: "piloto" },
      {
        id: "marina",
        label: "Marina",
        kind: "agent",
        detail: "Recebe as respostas e o pedido original",
      },
      { id: "equipe", label: "Equipe", kind: "human" },
    ],
    edges: [
      { id: "a", source: "entrada", target: "regra", label: "Nova mensagem", verified: true },
      { id: "b", source: "regra", target: "formulario", label: "Elegível", verified: true },
      {
        id: "c",
        source: "regra",
        target: "equipe",
        label: "Solicitou uma pessoa",
        verified: false,
      },
      {
        id: "d",
        source: "formulario",
        target: "marina",
        label: "Respostas enviadas",
        verified: true,
      },
    ],
  },
  divergences: [
    {
      id: "tres",
      severity: "warning",
      title: "Lista de áreas precisa de conferência",
      detail:
        "A resposta observada citou três áreas; verificar se apresentou todas as opções disponíveis.",
      flow_id: "piloto",
      screen_id: "PLANO",
    },
  ],
  scenarios: [
    {
      id: "medio",
      title: "Só ensino médio",
      description: "Veja as possibilidades antes de escolher um curso técnico.",
      flow_id: "piloto",
      answers: [{ screen: "INICIO", data: { formacao: "medio" } }],
    },
  ],
  agent: {
    name: "Marina",
    version: "exemplo",
    instructions: "Consulte as opções disponíveis na base antes de orientar a pessoa.",
  },
};
