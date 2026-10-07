/**
 * (C01) CAMPO LARGO OCUPA A LINHA INTEIRA, QUALQUER QUE SEJA A GRADE.
 *
 * O painel do inbox (`CRMSidePanel`) passa `className="gap-3 md:grid-cols-1"` ao
 * editor de campos. Com `md:col-span-2` no texto longo e no sim/não, o CSS Grid
 * criava uma segunda coluna implícita só para eles, e os rótulos vizinhos
 * ficavam uns sobre os outros. `md:col-span-full` (`grid-column: 1 / -1`) vale
 * para a grade de 2 colunas do dossiê e para a de 1 coluna do painel.
 *
 * O jsdom não calcula layout; o que se prova aqui é a classe, que é o conserto.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/auth/AuthProvider", () => ({ useActiveOrg: () => null }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { CustomFieldsEditor, type CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";

afterEach(cleanup);

const CAMPOS: CustomFieldDef[] = [
  { key: "curso", label: "Curso", type: "text" },
  { key: "observacoes", label: "Observações", type: "textarea" },
  { key: "aceitou", label: "Aceitou o contato", type: "boolean" },
];

describe("campo largo no editor de campos personalizados", () => {
  it("no painel lateral (grade de 1 coluna), texto longo e sim/não ocupam a linha sem criar coluna", () => {
    const { container } = render(
      <CustomFieldsEditor
        mode="lead"
        fields={CAMPOS}
        value={{}}
        onChange={() => {}}
        className="gap-3 md:grid-cols-1"
      />,
    );
    const largos = [
      container.querySelector("#cf-observacoes")?.closest("div.space-y-2"),
      container.querySelector("#cf-aceitou")?.parentElement,
    ];
    for (const el of largos) {
      expect(el).toBeTruthy();
      expect(el!.className).toContain("md:col-span-full");
    }
    expect(container.innerHTML).not.toContain("md:col-span-2");
  });
});
