/**
 * (C01, -c01.7) GET/PUT /api/v1/ai/send-guards — as travas de envio que se ligam pela
 * tela, por organização ("Confere antes de enviar").
 *
 * Hoje uma só: `link_e_valor_de_ferramenta` (ver
 * `lib/agent-engine/guardrails/link-e-valor-de-ferramenta.ts`). A escolha fica numa
 * linha de `org_guardrail_layers` com a chave `trava:<nome>` — a coluna `layer` é
 * vocabulário aberto, então não há mudança de banco. Ausência de linha = desligada
 * (a trava vem desligada). O turno do agente lê a mesma linha
 * (`lerTravasDeEnvioDaOrg`); o GET é a conferência depois de ligar.
 *
 * O mesmo molde de `/api/v1/ai/style-adjustments`: lista FECHADA no PUT (um nome fora
 * dela é recusado, e nenhuma trava fixa da cadeia se desliga por aqui), leitura por
 * gerente, escrita por admin, client de sessão (a RLS da migration 0142 faz a
 * tenancy), auditoria da troca.
 */
import { requireSupportWrite } from "@/lib/impersonate/support";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import {
  TRAVAS_COM_INTERRUPTOR,
  chaveDoInterruptor,
} from "@/lib/agent-engine/guardrails/link-e-valor-de-ferramenta";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const corpoDoPut = z
  .object({
    trava: z.enum(TRAVAS_COM_INTERRUPTOR),
    enabled: z.boolean(),
  })
  .strict();

export async function GET(): Promise<Response> {
  const authz = await requireRole("manager", { resource: "ai_send_guards" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const db = await createClient();
  const { data, error } = await db
    .from("org_guardrail_layers")
    .select("layer, enabled")
    .eq("organization_id", org.orgId)
    .in("layer", TRAVAS_COM_INTERRUPTOR.map(chaveDoInterruptor));

  if (error) return fail("read_failed", error.message, 500);

  const escolhas = new Map((data ?? []).map((row) => [row.layer as string, row.enabled === true]));

  return ok({
    travas: TRAVAS_COM_INTERRUPTOR.map((trava) => ({
      trava,
      enabled: escolhas.get(chaveDoInterruptor(trava)) ?? false,
    })),
    podeEditar: roleAtLeast(org.role, "admin"),
  });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("admin", { resource: "ai_send_guards" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const parsed = corpoDoPut.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_body", t("corpo inválido"), 422, { details: parsed.error.issues });
  }

  const db = await createClient();
  const { data: gravado, error } = await db
    .from("org_guardrail_layers")
    .upsert(
      {
        organization_id: org.orgId,
        layer: chaveDoInterruptor(parsed.data.trava),
        enabled: parsed.data.enabled,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,layer" },
    )
    .select("layer, enabled")
    .maybeSingle();

  if (error) return fail("save_failed", error.message, 500);
  if (!gravado) {
    return fail("save_failed", t("nada foi gravado — verifique as permissões da organização"), 500);
  }

  void audit({
    action: "ai.send_guard_changed",
    organizationId: org.orgId,
    actorUserId: user.id,
    resourceType: "org_guardrail_layers",
    resourceId: null,
    metadata: { trava: parsed.data.trava, enabled: parsed.data.enabled },
  });

  return ok({ trava: parsed.data.trava, enabled: gravado.enabled === true });
}
