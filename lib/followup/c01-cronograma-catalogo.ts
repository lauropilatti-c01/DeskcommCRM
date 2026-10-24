import type { Queryable } from "@/lib/agent-engine/queue/queue";
import type { Acesso } from "@/lib/external-db/acesso";
import type { Dialeto } from "@/lib/external-db/dialeto";
import { hashDoCorpo } from "@/lib/api/idempotency";
import { configOrigemC01, conferirOrigemC01, type ConfigOrigemC01 } from "./c01-origem";
import type { FlowGraph } from "./graph-schema";

export const TAGS_CATALOGO_C01 = ["a1-enfase-com-cronograma", "a1-area-desconhecida"] as const;
export type CatalogoCronogramaC01 =
  | { status: "indisponivel"; reason: string }
  | { status: "area_desconhecida"; evidenceHash: string }
  | { status: "sem_material"; enfaseNome: string; evidenceHash: string }
  | {
      status: "confirmado";
      enfaseNome: string;
      familyId: string;
      slug: string;
      evidenceHash: string;
    };
type Abrir = (org: string, connection: string) => Promise<Acesso>;
async function abrirPadrao(org: string, id: string) {
  const [{ abrirAcesso }, { createAdminClient }] = await Promise.all([
    import("@/lib/external-db/acesso"),
    import("@/lib/supabase/admin"),
  ]);
  return abrirAcesso(createAdminClient(), org, id);
}
const indisponivel = (reason: string): CatalogoCronogramaC01 => ({
  status: "indisponivel",
  reason,
});
async function tabela(
  d: Dialeto,
  schema: string,
  name: string,
  columns: string[],
  filters: { coluna: string; operador: "eq"; valor: string }[],
  maxRows = 200,
) {
  const available = await d.colunasDaTabela(schema, name);
  if (!available || columns.some((c) => !available.has(c)))
    throw new Error("fonte_ou_coluna_nao_liberada");
  const limit = Math.min(200, maxRows);
  if (!Number.isInteger(limit) || limit < 2) throw new Error("limite_insuficiente");
  const result = await d.lerTabela(
    { schema, tabela: name, colunas: columns, filtros: filters, limite: limit, offset: 0 },
    available,
    { limiteMax: limit },
  );
  if (result.offset !== 0 || result.linhas.length >= result.limite)
    throw new Error("catalogo_incompleto");
  return result.linhas;
}
const blank = (x: unknown) => x == null || x === "";
/** Consulta a conexão canônica autenticada. Nem o nome digitado nem as tags provam material. */
export async function lerCatalogoCronogramaC01(
  db: Queryable,
  cfg: ConfigOrigemC01,
  scope: { organizationId: string; contactId: string; leadId: string },
  abrir: Abrir = abrirPadrao,
): Promise<CatalogoCronogramaC01> {
  try {
    const policy = cfg.cronogramaCatalog;
    if (
      !cfg.enabled ||
      cfg.organizationId !== scope.organizationId ||
      !policy?.enabled ||
      policy.policyStatus !== "approved"
    )
      return indisponivel("catalogo_desligado");
    const org = (
      await db.query("select settings from organizations where id=$1", [scope.organizationId])
    ).rows[0];
    if (
      org?.settings?.c01_contextual_catalog?.enabled !== true ||
      org.settings.c01_contextual_catalog.connection_id !== policy.connectionId
    )
      return indisponivel("conexao_canonica_nao_confirmada");
    const rows = (
      await db.query(
        "select id,custom_fields from crm_leads where organization_id=$1 and contact_id=$2 and status='open'",
        [scope.organizationId, scope.contactId],
      )
    ).rows;
    if (rows.length !== 1 || rows[0]?.id !== scope.leadId)
      return indisponivel("oportunidade_nao_unica");
    const fields = rows[0]!.custom_fields ?? {},
      key = fields.enfase_chave,
      company = fields.empresa_alvo;
    // Ausência da chave com nome/área já preenchidos é incompletude, não área desconhecida.
    if (blank(key)) {
      if (
        !blank(fields.enfase_nome) ||
        [fields.area_petrobras, fields.area_transpetro].some((v) => !blank(v) && v !== "não sei")
      )
        return indisponivel("area_sem_chave_canonica");
      return { status: "area_desconhecida", evidenceHash: hashDoCorpo({ scope, fields }) };
    }
    if (
      typeof key !== "string" ||
      !/^(PB|TP)-[A-Z0-9.\-]+#\d+$/.test(key) ||
      !["Petrobras", "Transpetro", "As duas"].includes(company)
    )
      return indisponivel("perfil_invalido");
    const access = await abrir(scope.organizationId, policy.connectionId);
    if (
      !access.ok ||
      access.conexao.id !== policy.connectionId ||
      access.conexao.organizationId !== scope.organizationId
    )
      return indisponivel("fonte_autenticada_indisponivel");
    const details = await tabela(
      access.dialeto,
      "c01",
      "agente_enfase_detalhe",
      ["enfase_chave", "enfase", "empresa", "career_family_id", "produto_id"],
      [{ coluna: "enfase_chave", operador: "eq", valor: key }],
      access.conexao.maxRows,
    );
    if (details.length !== 1) return indisponivel("enfase_ausente_ou_ambigua");
    const detail = details[0]!;
    if (
      detail.enfase_chave !== key ||
      !["Petrobras", "Transpetro"].includes(String(detail.empresa)) ||
      (company !== "As duas" && company !== detail.empresa) ||
      typeof detail.career_family_id !== "string" ||
      (fields.produto_chave && fields.produto_chave !== detail.produto_id) ||
      typeof detail.enfase !== "string" ||
      !detail.enfase.trim() ||
      detail.enfase.length > 160 ||
      /[\r\n{}<>]|https?:/i.test(detail.enfase)
    )
      return indisponivel("enfase_fora_do_perfil");
    const families = await tabela(
      access.dialeto,
      "c01",
      "familia_produto",
      ["career_family_id", "cronograma", "empresas"],
      [{ coluna: "career_family_id", operador: "eq", valor: detail.career_family_id }],
      access.conexao.maxRows,
    );
    if (
      families.length !== 1 ||
      families[0]!.career_family_id !== detail.career_family_id ||
      !Array.isArray(families[0]!.empresas) ||
      !families[0]!.empresas.includes(detail.empresa)
    )
      return indisponivel("familia_incoerente");
    // O inventário publicado resolve divergências da taxonomia pelo edital. Não
    // confundir EAOAP/ESFCEX ou material da outra empresa com material desta ênfase.
    const aliases = await tabela(
      access.dialeto,
      "ref",
      "familia_cargo_alias",
      ["career_family_id", "sistema", "alias", "origem", "edital_id"],
      [
        { coluna: "career_family_id", operador: "eq", valor: detail.career_family_id },
        { coluna: "sistema", operador: "eq", valor: "cronograma" },
      ],
      access.conexao.maxRows,
    );
    if (
      aliases.some(
        (a) =>
          a.career_family_id !== detail.career_family_id ||
          a.sistema !== "cronograma" ||
          typeof a.edital_id !== "string" ||
          !/^(PB|TP)-/.test(a.edital_id),
      )
    )
      return indisponivel("inventario_sem_empresa");
    const prefix = detail.empresa === "Petrobras" ? "PB-" : "TP-",
      matches = aliases.filter((a) => String(a.edital_id).startsWith(prefix));
    const current = (
      await db.query(
        "select id,custom_fields from crm_leads where organization_id=$1 and contact_id=$2 and status='open'",
        [scope.organizationId, scope.contactId],
      )
    ).rows;
    if (
      current.length !== 1 ||
      current[0]?.id !== scope.leadId ||
      hashDoCorpo(current[0]!.custom_fields ?? {}) !== hashDoCorpo(fields)
    )
      return indisponivel("perfil_alterado_durante_consulta");
    const evidenceHash = hashDoCorpo({
      scope,
      connectionId: policy.connectionId,
      detail,
      family: families[0],
      aliases,
    });
    if (matches.length === 0)
      return { status: "sem_material", enfaseNome: detail.enfase, evidenceHash };
    if (
      matches.length !== 1 ||
      matches[0]!.origem !== "enfase_edital" ||
      typeof matches[0]!.alias !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,199}$/.test(matches[0]!.alias)
    )
      return indisponivel("material_ambiguo");
    return {
      status: "confirmado",
      enfaseNome: detail.enfase,
      familyId: detail.career_family_id,
      slug: matches[0]!.alias,
      evidenceHash,
    };
  } catch {
    return indisponivel("consulta_catalogo_incompleta");
  }
}

export function exigeCatalogoCronogramaC01(graph: FlowGraph) {
  return (
    graph.settings?.c01_acompanhamento?.kind === "cronograma" &&
    graph.nodes.some(
      (n) =>
        n.type === "condition" &&
        n.config.checks.some(
          (c) =>
            c.field === "tag" &&
            TAGS_CATALOGO_C01.includes(c.value as (typeof TAGS_CATALOGO_C01)[number]),
        ),
    )
  );
}
export async function resolverRamoCronogramaC01(
  db: Queryable,
  scope: { organizationId: string; contactId: string; enrollmentId: string },
  graph: FlowGraph,
  versionId: string,
) {
  const cfg = configOrigemC01(),
    p = cfg?.cronogramaCatalog;
  const binding = p?.bindings.filter((b) => b.versionId === versionId);
  if (!cfg || !p?.enabled || p.policyStatus !== "approved" || binding?.length !== 1)
    return { status: "indisponivel" as const, reason: "politica_catalogo_sem_vinculo" };
  const b = binding[0]!,
    withMaterial = graph.nodes.find((n) => n.id === b.withMaterialNodeId),
    unknown = graph.nodes.find((n) => n.id === b.unknownAreaNodeId),
    end = graph.nodes.find((n) => n.id === b.noMaterialNodeId);
  if (
    withMaterial?.type !== "action" ||
    withMaterial.config.mode !== "text" ||
    unknown?.type !== "action" ||
    unknown.config.mode !== "text" ||
    end?.type !== "end" ||
    end.config.outcome !== "custom" ||
    hashDoCorpo(withMaterial.config.body) !== b.withMaterialBodyHash ||
    hashDoCorpo(unknown.config.body) !== b.unknownAreaBodyHash
  )
    return { status: "indisponivel" as const, reason: "textos_catalogo_divergentes" };
  const events = (
    await db.query(
      "select payload from followup_enrollment_events where organization_id=$1 and enrollment_id=$2 and event_type='c01_origem_entregue'",
      [scope.organizationId, scope.enrollmentId],
    )
  ).rows;
  const origin = events.length === 1 ? conferirOrigemC01(cfg, events[0]!.payload) : null;
  if (
    !origin ||
    origin.kind !== "cronograma" ||
    origin.organizationId !== scope.organizationId ||
    origin.contactId !== scope.contactId
  )
    return { status: "indisponivel" as const, reason: "origem_catalogo_invalida" };
  const result = await lerCatalogoCronogramaC01(db, cfg, { ...scope, leadId: origin.leadId });
  if (result.status === "indisponivel") return result;
  const targetNodeId =
    result.status === "confirmado"
      ? b.withMaterialNodeId
      : result.status === "area_desconhecida"
        ? b.unknownAreaNodeId
        : b.noMaterialNodeId;
  const body =
    result.status === "confirmado"
      ? withMaterial.config.body.replaceAll("{{enfase_nome}}", result.enfaseNome)
      : result.status === "area_desconhecida"
        ? unknown.config.body
        : null;
  if (body && /{{|}}/.test(body))
    return { status: "indisponivel" as const, reason: "variavel_catalogo_nao_resolvida" };
  return { ...result, targetNodeId, body };
}
