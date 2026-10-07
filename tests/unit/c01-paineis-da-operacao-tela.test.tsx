/**
 * (C01, -c01.7) A tela dos painéis da operação: uma aba por painel, texto do serviço
 * sempre como texto puro, seção de tipo desconhecido com aviso discreto, busca dentro
 * da aba e um estado vazio por falha — sem endereço nem segredo na tela.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { PaineisClient, type PainelNaTela } from "@/app/app/ai/paineis/_client";

afterEach(cleanup);

const PAINEIS: PainelNaTela[] = [
  {
    id: "mensagens-prontas",
    titulo: "Mensagens prontas",
    descricao: "O que sai antes de a IA falar.",
    atualizado_em: "2026-10-07T19:40:00Z",
    atualizadoEmTexto: "07/10/2026 16:40",
    secoes: [
      {
        tipo: "mensagens",
        titulo: "1. Logo depois do oi",
        texto: "Quem chega sem nada recebe o link.",
        mensagens: [
          { rotulo: "Link do teste", quando: "logo depois do oi", texto: "Oi, tudo bem?\n<b>Faz</b> o teste.", botao: "Ver minhas ênfases" },
          { rotulo: "Lembrete", quando: "30 s depois", texto: "Ainda dá tempo.", botao: "" },
        ],
      },
      { tipo: "desconhecido", titulo: "Gráfico", texto: "", tipoRecebido: "grafico" },
    ],
  },
  {
    id: "fatos",
    titulo: "Base de fatos",
    descricao: "",
    atualizado_em: "",
    atualizadoEmTexto: null,
    secoes: [
      {
        tipo: "tabela",
        titulo: "Fatos",
        texto: "",
        colunas: ["Assunto", "O que ela diz"],
        linhas: [
          ["Concurso", "O caminho é o concurso público."],
          ["Salário", "O salário inicial está no edital."],
        ],
      },
    ],
  },
];

describe("a tela dos painéis", () => {
  it("abre uma aba por painel, com o título do painel", () => {
    render(<PaineisClient estado="ok" paineis={PAINEIS} />);
    const abas = screen.getAllByRole("tab").map((a) => a.textContent);
    expect(abas).toEqual(["Mensagens prontas", "Base de fatos"]);
    expect(screen.getByText("O que sai antes de a IA falar.")).toBeTruthy();
    expect(screen.getByText("Atualizado em {data}".replace("{data}", "07/10/2026 16:40"))).toBeTruthy();
  });

  it("mostra o texto do serviço como texto puro, com as quebras de linha", () => {
    const { container } = render(<PaineisClient estado="ok" paineis={PAINEIS} />);
    const texto = screen.getByText((_, el) => el?.tagName === "P" && el.textContent === "Oi, tudo bem?\n<b>Faz</b> o teste.");
    expect(texto.className).toContain("whitespace-pre-wrap");
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("Ver minhas ênfases")).toBeTruthy();
  });

  it("seção de tipo desconhecido vira só um aviso discreto", () => {
    render(<PaineisClient estado="ok" paineis={PAINEIS} />);
    expect(screen.getByText("A seção “Gráfico” é de um tipo que esta tela ainda não mostra.")).toBeTruthy();
  });

  it("a outra aba mostra a tabela", async () => {
    render(<PaineisClient estado="ok" paineis={PAINEIS} />);
    await userEvent.click(screen.getByRole("tab", { name: "Base de fatos" }));
    expect(screen.getAllByText("O caminho é o concurso público.").length).toBeGreaterThan(0);
    expect(screen.getByRole("columnheader", { name: "Assunto" })).toBeTruthy();
  });

  it("a busca filtra dentro da aba, sem acento e sem caixa", async () => {
    render(<PaineisClient estado="ok" paineis={PAINEIS} />);
    const busca = screen.getByRole("searchbox", { name: "Buscar nesta aba" });
    await userEvent.type(busca, "AINDA DA");
    expect(screen.queryByText("Link do teste")).toBeNull();
    expect(screen.getByText("Lembrete")).toBeTruthy();
    await userEvent.clear(busca);
    await userEvent.type(busca, "enfases");
    expect(screen.getByText("Link do teste")).toBeTruthy();
    await userEvent.clear(busca);
    await userEvent.type(busca, "zzz");
    expect(screen.getByText("Nada nesta aba tem “{busca}”.".replace("{busca}", "zzz"))).toBeTruthy();
  });

  it.each([
    ["desligado", "Nenhum sistema está conectado ao agente nesta instalação; quando estiver, os painéis que ele mandar aparecem aqui."],
    ["sem_paineis", "O sistema conectado ao agente não oferece painéis."],
    ["recusado", "O sistema conectado recusou a consulta porque a assinatura não confere dos dois lados."],
    ["indisponivel", "O sistema conectado não respondeu a tempo; tente de novo em alguns instantes."],
    ["formato", "O sistema conectado respondeu num formato que esta tela não sabe ler."],
    ["grande_demais", "A resposta do sistema conectado passou do tamanho que esta tela aceita."],
  ] as const)("estado %s: uma frase, sem quebrar a página", (estado, frase) => {
    const { container } = render(<PaineisClient estado={estado} />);
    expect(screen.getByText(frase)).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(container.textContent).not.toMatch(/https?:|172\.17|segredo/i);
  });

  it("serviço sem nenhum painel tem estado vazio próprio", () => {
    render(<PaineisClient estado="ok" paineis={[]} />);
    expect(screen.getByText("O sistema conectado ainda não mandou nenhum painel.")).toBeTruthy();
  });
});
