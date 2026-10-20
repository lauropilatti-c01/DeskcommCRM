/**
 * (C01, -c01.16) QUEM RECEBE O PUSH NO CELULAR.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * Numa empresa em que a IA atende, o push de mensagem (`message.received`) ia
 * para o celular de TODA a equipe, a cada mensagem de cliente: medido no
 * pré-lançamento da C01, um grupo de ~10 clientes por dia daria 100 a 150 toques
 * por pessoa. E o aviso que pede gente — a IA abriu um caso — não tocava em
 * celular nenhum: ficava só na Central (`caso-na-central.handler.ts`), que
 * ninguém olha com o CRM fechado no bolso.
 *
 * ─── O que este arquivo decide ──────────────────────────────────────────────
 *
 * 1. Mensagem de cliente: com `PUSH_DE_MENSAGEM` vazio ou `responsavel` (o
 *    padrão desta versão), o push vai só para quem responde por aquela conversa:
 *    a pessoa atribuída à conversa e o dono humano do negócio aberto do contato.
 *    Sem responsável, ninguém recebe — a IA está atendendo. `equipe` volta ao
 *    comportamento do autor (todos os aparelhos da organização).
 * 2. Negócio atribuído a uma pessoa enquanto há um caso esperando gente para
 *    ele: o push diz que é um caso e leva direto ao caso, não ao funil. É assim
 *    que a equipe distribui os casos (atribuindo o negócio) e quem recebe sabe
 *    que há um cliente esperando.
 *
 * Texto sem dado do cliente, como os avisos da Central (`push-dos-avisos.ts`):
 * o push aparece na tela bloqueada.
 */
import { env } from "@/lib/env";
import { REFERENCIAS_DE_AVISO } from "@/lib/ai/inbox-destino";
import type { PushPayload } from "./push_payload";

export type ModoDoPushDeMensagem = "responsavel" | "equipe";

/** Valor irreconhecível cai no padrão desta versão, sem lançar (mesma razão de `SIGNUP_MODE`). */
export function modoDoPushDeMensagem(valor: string | undefined = env.PUSH_DE_MENSAGEM): ModoDoPushDeMensagem {
  return (valor ?? "").trim().toLowerCase() === "equipe" ? "equipe" : "responsavel";
}

/** O mínimo do cliente do Supabase que estas leituras usam (facilita o teste). */
type Consulta = {
  select: (cols: string) => Consulta;
  eq: (col: string, v: unknown) => Consulta;
  in: (col: string, v: readonly unknown[]) => Consulta;
  order: (col: string, o: { ascending: boolean }) => Consulta;
  limit: (n: number) => Consulta;
  maybeSingle: () => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  then: PromiseLike<{ data: unknown; error: { message: string } | null }>["then"];
};
export type AdminDoPush = { from: (tabela: string) => Consulta };

/**
 * Quem responde pela conversa: a pessoa atribuída a ela e os donos humanos dos
 * negócios abertos do contato. `null` = a leitura falhou (quem chama decide
 * tentar de novo; não manda para a equipe toda por engano).
 */
export async function responsaveisDaConversa(
  admin: AdminDoPush,
  organizationId: string,
  conversationId: string | null,
  contactId: string | null,
): Promise<string[] | null> {
  const ids = new Set<string>();
  let contato = contactId;
  if (conversationId) {
    const { data, error } = await admin
      .from("conversations")
      .select("assigned_to_user_id, contact_id")
      .eq("organization_id", organizationId)
      .eq("id", conversationId)
      .maybeSingle();
    if (error) return null;
    const conv = data as { assigned_to_user_id?: string | null; contact_id?: string | null } | null;
    if (conv?.assigned_to_user_id) ids.add(conv.assigned_to_user_id);
    contato = contato ?? conv?.contact_id ?? null;
  }
  if (contato) {
    const { data, error } = await admin
      .from("crm_leads")
      .select("owner_user_id")
      .eq("organization_id", organizationId)
      .eq("contact_id", contato)
      .eq("status", "open")
      .eq("owner_kind", "user");
    if (error) return null;
    for (const l of (data as { owner_user_id?: string | null }[] | null) ?? []) {
      if (l.owner_user_id) ids.add(l.owner_user_id);
    }
  }
  return [...ids];
}

/** O caso mais recente do negócio que espera uma pessoa; `undefined` = a leitura falhou. */
export async function casoEsperandoGente(
  admin: AdminDoPush,
  organizationId: string,
  leadId: string,
): Promise<string | null | undefined> {
  const { data, error } = await admin
    .from("agent_cases")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("lead_id", leadId)
    .in("status", ["awaiting_human"])
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return undefined;
  return (data as { id?: string } | null)?.id ?? null;
}

export function pushDoCasoAtribuido(caseId: string): PushPayload {
  return {
    title: "Caso para você",
    body: "A IA pediu ajuda num atendimento. Abra o caso para responder.",
    tag: `caso:${caseId}`,
    href: REFERENCIAS_DE_AVISO.agent_case.href(caseId),
  };
}
