import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { hashDoCorpo } from "@/lib/api/idempotency";
import {
  resolverModeloOfertaC01,
  comConteudoResolvidoC01,
  conferirConteudoResolvidoC01,
  escopoDoConteudoC01,
} from "./c01-acompanhamento-conteudo";
import type { ConfigOrigemC01 } from "./c01-origem";

afterEach(() => vi.unstubAllEnvs());
function fixture() {
  const scope = {
    organizationId: randomUUID(),
    versionId: randomUUID(),
    nodeId: "d1",
    productKey: "produto-ficticio",
    connectionId: randomUUID(),
  };
  const template = {
    id: randomUUID(),
    name: "c01_d1_ficticio",
    language: "pt_BR",
    category: "MARKETING" as const,
    parameter_format: "POSITIONAL",
    components: [{ type: "BODY", text: "Deseja continuar pelo ponto que ficou pendente?" }],
    status: "APPROVED",
  };
  const binding = {
    ...scope,
    templateId: template.id,
    language: template.language,
    category: template.category,
    contentHash: hashDoCorpo({
      name: template.name,
      language: template.language,
      parameter_format: template.parameter_format,
      components: template.components,
    }),
  };
  const cfg: ConfigOrigemC01 = {
    enabled: true,
    organizationId: scope.organizationId,
    tokenSha256: "a".repeat(64),
    signingKey: "b".repeat(40),
    allowedKinds: ["oferta"],
    offerTemplates: { enabled: true, policyStatus: "approved", bindings: [binding] },
  };
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    expect(params[0]).toBe(scope.organizationId);
    if (sql.startsWith("select status")) {
      expect(params[1]).toBe(scope.connectionId);
      return { rows: [{ status: "WORKING" }] };
    }
    if (sql.startsWith("select language")) return { rows: [template] };
    if (sql.startsWith("select name")) {
      expect(params[1]).toBe(template.id);
      return { rows: [template] };
    }
    expect(sql).toContain("s.meta_waba_id = t.waba_id");
    expect(params[3]).toBe(scope.connectionId);
    return { rows: [template] };
  });
  return { scope, template, binding, cfg, query, db: { query } as unknown as Queryable };
}
describe("modelo exato da oferta, resolvido pelo servidor", () => {
  it("usa o resolvedor nativo com ID, conteúdo e conexão vinculados", async () => {
    const f = fixture();
    expect(await resolverModeloOfertaC01(f.db, f.cfg, f.scope)).toMatchObject({
      tipo: "modelo_aprovado",
      body: f.template.components[0]!.text,
      modelo: { name: f.template.name, language: "pt_BR", values: {} },
    });
    expect(f.query).toHaveBeenCalledTimes(4);
  });
  it.each(["organizationId", "versionId", "nodeId", "productKey", "connectionId"] as const)(
    "não transfere vínculo para outro %s",
    async (field) => {
      const f = fixture();
      expect(
        await resolverModeloOfertaC01(f.db, f.cfg, { ...f.scope, [field]: "outro" }),
      ).toBeNull();
      expect(f.query).not.toHaveBeenCalled();
    },
  );
  it("recusa política candidata, vínculo duplicado e canal parado", async () => {
    const f = fixture();
    f.cfg.offerTemplates!.policyStatus = "proposed";
    expect(await resolverModeloOfertaC01(f.db, f.cfg, f.scope)).toBeNull();
    f.cfg.offerTemplates!.policyStatus = "approved";
    f.cfg.offerTemplates!.bindings.push(f.binding);
    expect(await resolverModeloOfertaC01(f.db, f.cfg, f.scope)).toBeNull();
    f.cfg.offerTemplates!.bindings.pop();
    f.query.mockResolvedValueOnce({ rows: [{ status: "STOPPED" }] });
    expect(await resolverModeloOfertaC01(f.db, f.cfg, f.scope)).toBeNull();
  });
  it("reclassificação de conteúdo, reprovação e ID divergente não viram texto livre", async () => {
    for (const mutate of [
      (t: ReturnType<typeof fixture>["template"]) => {
        t.components[0]!.text = "Texto alterado";
      },
      (t: ReturnType<typeof fixture>["template"]) => {
        t.status = "REJECTED";
      },
      (t: ReturnType<typeof fixture>["template"]) => {
        t.id = randomUUID();
      },
    ]) {
      const f = fixture();
      mutate(f.template);
      // A primeira busca mantém o ID solicitado; a definição atual é a prova decisiva.
      f.query.mockImplementation(async (sql: string) => ({
        rows: sql.startsWith("select status") ? [{ status: "WORKING" }] : [f.template],
      }));
      expect(await resolverModeloOfertaC01(f.db, f.cfg, f.scope)).toBeNull();
    }
  });
  it("reclassificação de categoria interrompe até nova revisão", async () => {
    const f = fixture();
    Object.assign(f.template, { category: "UTILITY" });
    expect(await resolverModeloOfertaC01(f.db, f.cfg, f.scope)).toBeNull();
  });
  it("modelo com variável continua recusado mesmo com hash aprovado", async () => {
    const f = fixture();
    f.template.components[0]!.text = "Olá {{1}}";
    f.binding.contentHash = hashDoCorpo({
      name: f.template.name,
      language: f.template.language,
      parameter_format: f.template.parameter_format,
      components: f.template.components,
    });
    expect(await resolverModeloOfertaC01(f.db, f.cfg, f.scope)).toBeNull();
  });
});

describe("conteúdo relido na fronteira do envio", () => {
  const scope = {
    organizationId: "org",
    contactId: "person",
    enrollmentId: "enroll",
    nodeId: "node",
    connectionId: "channel",
    jobId: "job",
  };
  it("mudança de área no mesmo ramo bloqueia texto antigo; replay sem contexto também", async () => {
    const first = { tipo: "texto", body: "Cronograma de Operação" };
    await comConteudoResolvidoC01(scope, first, async () => {
      expect(() => conferirConteudoResolvidoC01(scope, first)).not.toThrow();
      expect(() =>
        conferirConteudoResolvidoC01(scope, { ...first, body: "Cronograma de Inspeção" }),
      ).toThrow("alterado");
      expect(() => conferirConteudoResolvidoC01({ ...scope, jobId: "outro" }, first)).toThrow(
        "contexto",
      );
      expect(() => conferirConteudoResolvidoC01(scope, null)).toThrow("alterado");
    });
    expect(() => escopoDoConteudoC01(scope)).toThrow("contexto");
  });
  it("mudança de modelo/idioma com o mesmo corpo também é diferença material", async () => {
    const first = {
      tipo: "modelo_aprovado",
      body: "Texto",
      modelo: { name: "aprovado", language: "pt_BR", values: {} },
    };
    await comConteudoResolvidoC01(scope, first, async () => {
      expect(() =>
        conferirConteudoResolvidoC01(scope, {
          ...first,
          modelo: { ...first.modelo, name: "outro" },
        }),
      ).toThrow("alterado");
    });
  });
});
