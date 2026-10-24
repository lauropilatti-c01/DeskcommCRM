import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { conversasVisiveisDosCasos, listarChamados } from "@/lib/escalacao/chamados";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const OUTRA = "aaaaaaaa-0000-4000-8000-000000000002";
const id = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`;
const caso = (n: number, conversationId = id(n)) => ({
  id: id(n + 10_000),
  organization_id: ORG,
  conversation_id: conversationId,
  title: "Pedido fictício",
  summary: "Dúvida fictícia",
  blocker: "Equipe",
  kind: "outro",
  status: "awaiting_human",
  opened_at: new Date(Date.UTC(2026, 9, 1, 0, n % 13)).toISOString(),
  conversations: { contacts: { name: "Pessoa fictícia", phone_number: null } },
});
type Caso = ReturnType<typeof caso>;
type Chamada = { tabela: string; params: URLSearchParams; head: boolean; tamanho: number };

/** Usa o cliente PostgREST real e uma resposta HTTP fictícia: teto de 1.000
 * linhas e URI de 8 KB. Não há banco, rede, segredo ou dado real. */
function banco(casos: Caso[], visiveis: string[], falha?: (c: Chamada) => boolean) {
  const chamadas: Chamada[] = [];
  const cliente = createClient("http://fixture.invalid", "chave-ficticia", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        const c: Chamada = {
          tabela: url.pathname.split("/").at(-1)!,
          params: url.searchParams,
          head: init?.method === "HEAD",
          tamanho: url.href.length,
        };
        chamadas.push(c);
        if (c.tamanho > 8000 || falha?.(c)) {
          return new Response(
            JSON.stringify({
              message: c.tamanho > 8000 ? "URI too long" : "Falha fictícia",
              code: "fixture",
            }),
            { status: 414 },
          );
        }
        let rows: Array<Record<string, unknown>> =
          c.tabela === "conversations"
            ? visiveis.map((value) => ({ id: value, organization_id: ORG }))
            : [...casos];
        for (const [col, filtro] of c.params) {
          if (filtro.startsWith("eq.")) rows = rows.filter((r) => r[col] === filtro.slice(3));
          if (filtro.startsWith("in.(")) {
            const valores = filtro.slice(4, -1).split(",");
            rows = rows.filter((r) => valores.includes(String(r[col])));
          }
        }
        const total = rows.length;
        const ordens = (c.params.get("order") ?? "").split(",").filter(Boolean);
        rows.sort((a, b) => {
          for (const ordem of ordens) {
            const [col, sentido] = ordem.split(".");
            if (!col) throw new Error("Ordenação fictícia sem coluna");
            const diff = String(a[col]).localeCompare(String(b[col]));
            if (diff) return sentido === "desc" ? -diff : diff;
          }
          return 0;
        });
        const offset = Number(c.params.get("offset") ?? 0);
        const limite = Math.min(1000, Number(c.params.get("limit") ?? 1000));
        const data = rows.slice(offset, offset + limite);
        return new Response(c.head ? null : JSON.stringify(data), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-range": `0-${Math.max(0, data.length - 1)}/${total}`,
          },
        });
      },
    },
  });
  return { cliente, chamadas };
}

const esperados = (casos: Caso[]) =>
  [...casos]
    .sort((a, b) => b.opened_at.localeCompare(a.opened_at) || b.id.localeCompare(a.id))
    .map((c) => c.id);

describe("fila grande sem URI gigante nem truncamento do PostgREST", () => {
  it("pagina 1.250 candidatas e mantém só o subconjunto autorizado pela sessão", async () => {
    const casos = Array.from({ length: 1250 }, (_, i) => caso(i));
    const visiveis = casos.filter((_, i) => i % 3 === 0).map((c) => c.conversation_id);
    const db = banco(
      [...casos, { ...caso(2000), organization_id: OUTRA }, caso(1500, id(0))],
      visiveis,
    );
    expect((await conversasVisiveisDosCasos(db.cliente, ORG)).sort()).toEqual([...visiveis].sort());
    expect(
      db.chamadas.every((c) => c.tamanho < 8000 && c.params.get("organization_id") === `eq.${ORG}`),
    ).toBe(true);
  });

  it("lista mais de 200 conversas sem expor caso oculto ou de outra organização", async () => {
    const casos = Array.from({ length: 210 }, (_, i) => caso(i));
    const visiveis = casos.map((c) => c.conversation_id);
    const db = banco(
      [...casos, caso(9999), { ...caso(9000, id(0)), organization_id: OUTRA }],
      visiveis,
    );
    const resultado = await listarChamados(db.cliente, ORG, {
      estado: "abertos",
      visiveisPara: visiveis,
    });
    expect(resultado.chamados.map((c) => c.id)).toEqual(esperados(casos));
    expect(resultado.abertos).toBe(210);
  });

  it("não corta em 1.000 quando uma só conversa tem 1.250 casos", async () => {
    const casos = Array.from({ length: 1250 }, (_, i) => caso(i, id(1)));
    const db = banco(casos, [id(1)]);
    const resultado = await listarChamados(db.cliente, ORG, {
      estado: "abertos",
      visiveisPara: [id(1)],
    });
    expect(resultado.chamados.map((c) => c.id)).toEqual(esperados(casos));
    expect(resultado.abertos).toBe(1250);
  });

  it("ordena empates e aplica limite global; IDs repetidos não duplicam contagem", async () => {
    const casos = Array.from({ length: 310 }, (_, i) => caso(i));
    const visiveis = casos.map((c) => c.conversation_id).reverse();
    const db = banco(casos, visiveis);
    const resultado = await listarChamados(db.cliente, ORG, {
      estado: "abertos",
      limite: 17,
      visiveisPara: [...visiveis, ...visiveis.slice(0, 30)],
    });
    expect(resultado.chamados.map((c) => c.id)).toEqual(esperados(casos).slice(0, 17));
    expect(resultado.abertos).toBe(310);
  });

  it("não perde microssegundos ao ordenar datas de lotes diferentes", async () => {
    const casos = Array.from({ length: 110 }, (_, i) => caso(i));
    const maisRecente = { ...caso(0), opened_at: "2026-10-23T15:00:00.123456+00:00" };
    casos[0] = maisRecente;
    casos[109] = { ...caso(109), opened_at: "2026-10-23T15:00:00.123455+00:00" };
    const visiveis = casos.map((c) => c.conversation_id);
    const db = banco(casos, visiveis);
    const resultado = await listarChamados(db.cliente, ORG, {
      estado: "abertos",
      limite: 1,
      visiveisPara: visiveis,
    });
    expect(resultado.chamados.map((c) => c.id)).toEqual([maisRecente.id]);
  });

  it("fechados mantêm contador de abertos e zero continua limite válido", async () => {
    const casos = Array.from({ length: 220 }, (_, i) => ({
      ...caso(i),
      status: i % 2 ? "resolved" : "awaiting_lead",
    }));
    const visiveis = casos.map((c) => c.conversation_id);
    const db = banco(casos, visiveis);
    const resultado = await listarChamados(db.cliente, ORG, {
      estado: "fechados",
      limite: 9,
      visiveisPara: visiveis,
    });
    expect(resultado.chamados.map((c) => c.id)).toEqual(
      esperados(casos.filter((c) => c.status === "resolved")).slice(0, 9),
    );
    expect(resultado.abertos).toBe(110);
    expect(
      (
        await listarChamados(db.cliente, ORG, {
          estado: "abertos",
          limite: 0,
          visiveisPara: visiveis,
        })
      ).chamados,
    ).toEqual([]);
  });

  it("falha do segundo lote RLS recusa o conjunto parcial", async () => {
    const casos = Array.from({ length: 210 }, (_, i) => caso(i));
    let lotes = 0;
    const db = banco(
      casos,
      casos.map((c) => c.conversation_id),
      (c) => c.tabela === "conversations" && ++lotes === 2,
    );
    await expect(conversasVisiveisDosCasos(db.cliente, ORG)).rejects.toThrow("Falha fictícia");
  });

  it("falha da página posterior ou da contagem nunca devolve sucesso parcial", async () => {
    const casos = Array.from({ length: 250 }, (_, i) => caso(i, id(1)));
    for (const falha of [
      (c: Chamada) => Number(c.params.get("offset")) > 0,
      (c: Chamada) => c.head,
    ]) {
      const db = banco(casos, [id(1)], falha);
      await expect(
        listarChamados(db.cliente, ORG, { estado: "abertos", visiveisPara: [id(1)] }),
      ).rejects.toThrow("Falha fictícia");
    }
  });

  it("MCP conserva todas explícito e limite; conjunto vazio não consulta admin", async () => {
    const casos = Array.from({ length: 1250 }, (_, i) => caso(i));
    const db = banco(casos, []);
    expect(
      (
        await listarChamados(db.cliente, ORG, {
          estado: "abertos",
          limite: 11,
          visiveisPara: "todas",
        })
      ).chamados.map((c) => c.id),
    ).toEqual(esperados(casos).slice(0, 11));
    const vazio = banco(casos, []);
    expect(
      await listarChamados(vazio.cliente, ORG, { estado: "abertos", visiveisPara: [] }),
    ).toEqual({ chamados: [], abertos: 0 });
    expect(vazio.chamadas).toHaveLength(0);
  });
});
