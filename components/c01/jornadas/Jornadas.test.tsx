import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Jornadas from "./Jornadas";
import Cenarios from "./Cenarios";
import { exemplo } from "./fixture.test-data";
import { buscarEtapas, mapaFormulario, posicionar } from "./modelo";

vi.mock("next/dynamic", () => ({
  default: () =>
    function MapaTeste() {
      return <div data-testid="mapa" />;
    },
}));

beforeEach(() => {
  window.history.replaceState(null, "", "/app/jornadas");
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Jornadas", () => {
  it("busca nos textos e nas opções sem exigir acentos", () => {
    expect(buscarEtapas(exemplo, "tecnico").map((item) => item.screen.id)).toContain("PLANO");
    expect(buscarEtapas(exemplo, "ajuda para escolher")[0]?.screen.id).toBe("PLANO");
    expect(buscarEtapas(exemplo, "")).toEqual([]);
  });
  it("mostra publicação e ativação separadas, inclusive versão antiga", async () => {
    const user = userEvent.setup();
    render(<Jornadas initialSnapshot={exemplo} />);
    await user.click(screen.getByRole("tab", { name: "Formulários" }));
    expect(screen.getAllByText("Publicado na Meta")).toHaveLength(2);
    expect(screen.getByText("Habilitado para novas entradas")).toBeInTheDocument();
    expect(screen.getByText("Sem novas entradas")).toBeInTheDocument();
  });
  it("abre resultado de busca com texto, opções e destinos, atualizando link", async () => {
    const user = userEvent.setup();
    render(<Jornadas initialSnapshot={exemplo} />);
    await user.type(screen.getByLabelText("Buscar texto ou opção"), "ajuda para escolher");
    await user.click(screen.getByRole("button", { name: /Curso técnico.*Qualificação/ }));
    expect(screen.getByText("Não pretendo fazer agora")).toBeInTheDocument();
    expect(window.location.search).toContain("etapa=PLANO");
    await user.click(screen.getByRole("button", { name: /Já sei qual curso.*Buscar seu curso/ }));
    expect(window.location.search).toContain("etapa=BUSCA");
  });
  it("exibe indisponibilidade sem trocar a falha por dados de exemplo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: { message: "Leitor indisponível." } }),
      }),
    );
    render(<Jornadas />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Leitor indisponível");
    expect(screen.queryByText("Qualificação com busca")).not.toBeInTheDocument();
    expect(screen.getByText("Ainda não há uma leitura disponível")).toBeInTheDocument();
  });
  it("abre os detalhes em sheet no celular", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    const user = userEvent.setup();
    render(<Jornadas initialSnapshot={exemplo} />);
    await user.type(screen.getByLabelText("Buscar texto ou opção"), "ajuda para escolher");
    await user.click(screen.getByRole("button", { name: /Curso técnico.*Qualificação/ }));
    expect(
      within(screen.getByRole("dialog")).getByText("Quero ajuda para escolher"),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
  it("consulta estado de cada fonte e abre divergência na etapa relacionada", async () => {
    const user = userEvent.setup();
    render(<Jornadas initialSnapshot={exemplo} />);
    await user.click(screen.getByRole("tab", { name: /Conferência/ }));
    expect(screen.getByText("Versão ainda não reconhecida.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ver etapa relacionada" }));
    expect(screen.getByRole("tab", { name: "Mapa geral" })).toHaveAttribute("data-state", "active");
    expect(window.location.search).toContain("etapa=PLANO");
  });
  it("layout termina com ciclos e preserva todas as etapas", () => {
    const graph = mapaFormulario(exemplo.flows[0]!);
    graph.edges.push({
      id: "voltar",
      source: "RESULTADOS",
      target: "BUSCA",
      label: "Refinar",
      verified: true,
    });
    const nodes = posicionar(graph.nodes, graph.edges);
    expect(nodes).toHaveLength(5);
    expect(nodes.every((node) => Number.isFinite(node.position.y))).toBe(true);
  });
  it("distribui seis formulários em duas linhas sem invadir a próxima camada", () => {
    const forms = Array.from({ length: 6 }, (_, index) => ({
      id: `form-${index}`,
      label: `Formulário ${index}`,
      kind: "form",
    }));
    const nodes = [
      { id: "entrada", label: "Entrada", kind: "entry" },
      ...forms,
      { id: "saida", label: "Saída", kind: "exit" },
    ];
    const edges = forms.flatMap((form) => [
      {
        id: `in-${form.id}`,
        source: "entrada",
        target: form.id,
        label: "Condição",
        verified: true,
      },
      {
        id: `out-${form.id}`,
        source: form.id,
        target: "saida",
        label: "Conclusão",
        verified: true,
      },
    ]);
    const placed = posicionar(nodes, edges);
    const positionedForms = placed.filter((node) => node.kind === "form");
    expect(new Set(positionedForms.map((node) => node.position.x)).size).toBe(3);
    expect(new Set(positionedForms.map((node) => node.position.y)).size).toBe(2);
    expect(placed.find((node) => node.id === "saida")!.position.y).toBeGreaterThan(
      Math.max(...positionedForms.map((node) => node.position.y)),
    );
    expect(placed.map((node) => node.id)).toEqual(nodes.map((node) => node.id));
    expect(posicionar(nodes, edges)).toEqual(placed);
  });
});

describe("Cenários", () => {
  it("simula a conclusão da tela terminal para conferir a entrega ao CRM", async () => {
    const reply = {
      snapshot_id: exemplo.snapshot_id,
      flow_id: "piloto",
      steps: [{ screen: "FINAL", title: "Revisão das respostas", data: {} }],
      outcome: "Aguardando revisão.",
      verified: true,
      fields: {},
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: reply }) });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<Cenarios snapshot={exemplo} onPath={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /Só ensino médio/ }));
    await user.click(await screen.findByRole("button", { name: "Simular envio das respostas" }));
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).answers.at(-1)).toEqual({
      screen: "FINAL",
      data: {},
    });
    expect(screen.getByText("Nenhuma mensagem será enviada.")).toBeInTheDocument();
  });
  it("usa opções dinâmicas, envia replay cumulativo e mantém foto original", async () => {
    const reply = {
      snapshot_id: exemplo.snapshot_id,
      flow_id: "piloto",
      steps: [
        {
          screen: "RESULTADOS",
          title: "Cursos encontrados",
          data: { opcoes: [{ id: "mecanica", title: "Engenharia Mecânica" }] },
        },
      ],
      outcome: "Aguardando escolha.",
      verified: true,
      fields: {},
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: reply }) });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const view = render(<Cenarios snapshot={exemplo} onPath={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /Só ensino médio/ }));
    expect(await screen.findByRole("option", { name: "Engenharia Mecânica" })).toBeInTheDocument();
    view.rerender(<Cenarios snapshot={{ ...exemplo, snapshot_id: "foto-2" }} onPath={vi.fn()} />);
    expect(screen.getByText(/Este cenário continua usando a anterior/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Seu curso"), "mecanica");
    await user.click(screen.getByRole("button", { name: "Ver próxima etapa" }));
    const body = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(body.snapshot_id).toBe(exemplo.snapshot_id);
    expect(body.answers).toEqual([
      { screen: "INICIO", data: { formacao: "medio" } },
      { screen: "RESULTADOS", data: { curso: "mecanica" } },
    ]);
  });
  it("recusa resultado de uma fotografia diferente", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            snapshot_id: "outra",
            flow_id: "piloto",
            steps: [],
            verified: true,
            outcome: "ok",
            fields: {},
          },
        }),
      }),
    );
    render(<Cenarios snapshot={exemplo} onPath={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Só ensino médio/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("não corresponde à leitura");
    expect(screen.queryByText("Percurso conferido")).not.toBeInTheDocument();
  });
});
