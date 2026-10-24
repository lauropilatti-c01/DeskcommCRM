import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type * as UseCasesModule from "@/hooks/ai/useCases";

const useCasesMock = vi.fn();
vi.mock("@/hooks/ai/useCases", async () => {
  const actual = await vi.importActual<typeof UseCasesModule>("@/hooks/ai/useCases");
  return { ...actual, useCases: (...args: unknown[]) => useCasesMock(...args) };
});

// CaseDetail é testado à parte; aqui só a lista importa.
vi.mock("@/app/app/ai/cases/_components/CaseDetail", () => ({
  CaseDetail: ({ caseId }: { caseId: string | null }) => (
    <p data-testid="case-detail-selecionado">{caseId}</p>
  ),
}));

import { CaseList } from "@/app/app/ai/cases/_components/CaseList";

function wrap(ui: React.ReactNode) {
  return <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;
}

describe("CaseList", () => {
  it("renderiza os casos com o rótulo pt-br do status (nunca o enum cru)", () => {
    useCasesMock.mockReturnValue({
      isLoading: false,
      data: {
        open_count: 2,
        cases: [
          {
            id: "case-1",
            title: "Cliente pede desconto acima do permitido",
            summary: "Quer 30% de desconto",
            blocker: "Fora da política de descontos",
            status: "awaiting_human",
            opened_at: new Date().toISOString(),
            conversation_id: "conv-1",
            contact_name: "Maria Silva",
            contact_phone: "+5511999990000",
          },
          {
            id: "case-2",
            title: "Aguardando CPF do cliente",
            summary: "Precisa do CPF pra emitir nota",
            blocker: "Não tem o CPF",
            status: "awaiting_lead",
            opened_at: new Date().toISOString(),
            conversation_id: "conv-2",
            contact_name: "João Souza",
            contact_phone: "+5511988880000",
          },
        ],
      },
    });

    render(wrap(<CaseList />));

    expect(screen.getByText("Cliente pede desconto acima do permitido")).toBeInTheDocument();
    expect(screen.getByText("Aguardando você")).toBeInTheDocument();
    expect(screen.getByText("Aguardando o cliente")).toBeInTheDocument();
    expect(screen.queryByText("awaiting_human")).not.toBeInTheDocument();
    expect(screen.queryByText("awaiting_lead")).not.toBeInTheDocument();
  });

  it("estado vazio ensina o que é um caso", () => {
    useCasesMock.mockReturnValue({
      isLoading: false,
      data: { open_count: 0, cases: [] },
    });

    render(wrap(<CaseList />));

    expect(screen.getByText("Nenhum caso aberto")).toBeInTheDocument();
    expect(screen.getByText(/quando a ia precisar de você/i)).toBeInTheDocument();
  });

  it("permite abrir um caso, voltar à lista e abrir outro sem perder a aba", () => {
    useCasesMock.mockReturnValue({
      isLoading: false,
      data: {
        open_count: 2,
        cases: ["case-1", "case-2"].map((id) => ({
          id,
          title: `Pedido fictício ${id}`,
          kind: "outro",
          status: "awaiting_human",
          opened_at: new Date().toISOString(),
          conversation_id: `conv-${id}`,
          contact_name: "Pessoa fictícia",
        })),
      },
    });

    render(wrap(<CaseList />));
    fireEvent.click(screen.getByRole("button", { name: /Pedido fictício case-1/ }));
    expect(screen.getByTestId("case-detail-selecionado")).toHaveTextContent("case-1");
    fireEvent.click(screen.getByRole("button", { name: "Voltar" }));
    expect(screen.getByTestId("case-detail-selecionado")).toBeEmptyDOMElement();
    expect(screen.getByRole("tab", { name: "Abertos (2)" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: /Pedido fictício case-2/ }));
    expect(screen.getByTestId("case-detail-selecionado")).toHaveTextContent("case-2");
  });
});
