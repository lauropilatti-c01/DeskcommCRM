/**
 * (C01, -c01.7) GET/PUT /api/v1/ai/send-guards — as travas de envio que se ligam pela
 * tela, por organização ("Confere antes de enviar").
 *
 * As da lista `TRAVAS_COM_INTERRUPTOR` (`lib/agent-engine/guardrails/interruptores-de-trava.ts`):
 * `link_e_valor_de_ferramenta` e `valor_em_dinheiro`. A escolha fica numa linha de
 * `org_guardrail_layers` com a chave `trava:<nome>` — a coluna `layer` é vocabulário
 * aberto, então não há mudança de banco. O GET devolve o estado que VALE, pela mesma
 * função do turno (`interpretarTravasDeEnvio`): a linha, se existe; sem linha, a
 * `valor_em_dinheiro` segue o `settings.travas_de_envio` de antes, e a outra fica
 * desligada. `origem` diz de onde veio: `tela`, `configuracao` ou `padrao`.
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
  type TravaComInterruptor,
} from "@/lib/agent-engine/guardrails/interruptores-de-trava";
import { interpretarTravasDeEnvio } from "@/lib/agent-engine/guardrails/travas-de-envio";
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
  const [camadas, organizacao] = await Promise.all([
    db
      .from("org_guardrail_layers")
      .select("layer, enabled")
      .eq("organization_id", org.orgId)
      .in("layer", TRAVAS_COM_INTERRUPTOR.map(chaveDoInterruptor)),
    db.from("organizations").select("settings").eq("id", org.orgId).maybeSingle(),
  ]);

  if (camadas.error) return fail("read_failed", camadas.error.message, 500);
  if (organizacao.error) return fail("read_failed", organizacao.error.message, 500);

  const escolhas = new Map((camadas.data ?? []).map((row) => [row.layer as string, row.enabled === true]));
  const daTela = (trava: TravaComInterruptor): boolean | null => escolhas.get(chaveDoInterruptor(trava)) ?? null;
  const settings = (organizacao.data?.settings ?? null) as { travas_de_envio?: unknown } | null;
  const { travas } = interpretarTravasDeEnvio(settings?.travas_de_envio ?? null, {
    linkEValorDeFerramenta: daTela("link_e_valor_de_ferramenta"),
    valorEmDinheiro: daTela("valor_em_dinheiro"),
  });
  const efetivo: Record<TravaComInterruptor, boolean> = {
    link_e_valor_de_ferramenta: travas.linkEValorDeFerramenta,
    valor_em_dinheiro: travas.valorEmDinheiro,
  };

  return ok({
    travas: TRAVAS_COM_INTERRUPTOR.map((trava) => ({
      trava,
      enabled: efetivo[trava],
      origem: daTela(trava) !== null ? "tela" : efetivo[trava] ? "configuracao" : "padrao",
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
