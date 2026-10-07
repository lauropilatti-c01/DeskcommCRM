import { redirect } from "next/navigation";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { buscarPaineis, configDosPaineis } from "@/lib/ai/paineis/buscar";
import { dataDoPainel } from "@/lib/ai/paineis/contrato";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

import { PaineisClient } from "./_client";

export const dynamic = "force-dynamic";

/**
 * (C01, -c01.7) Painéis da operação: o que o serviço do gancho antes do turno manda
 * para consulta (`lib/ai/paineis`), só leitura. A busca é no servidor, a cada
 * abertura da tela, e não muda nada do turno do agente.
 *
 * O cabeçalho sai na hora; os painéis chegam por `Suspense`, porque o serviço tem
 * até 5 s para responder.
 */
export default async function PaineisPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  // O mesmo papel mínimo de Skills e Memória, as vizinhas em "Ensinar o agente".
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const idioma = user.idioma;
  const fuso = fusoUtilizavel(user.timezone, activeOrg.timezone);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Painéis da operação", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "O que o sistema conectado ao agente manda para consulta: mensagens prontas e as informações que ele usa. Esta tela só mostra; para mudar algo, altere no próprio sistema.",
            idioma,
          )}
        </p>
      </header>
      <Suspense fallback={<CarregandoPaineis />}>
        <PaineisDoServico idioma={idioma} fuso={fuso} />
      </Suspense>
    </div>
  );
}

async function PaineisDoServico({ idioma, fuso }: { idioma: Idioma; fuso: string }) {
  const config = configDosPaineis();
  if (!config) return <PaineisClient estado="desligado" />;
  const resultado = await buscarPaineis(config);
  if (resultado.estado !== "ok") return <PaineisClient estado={resultado.estado} />;
  const tag = tagDeIdioma(idioma);
  return (
    <PaineisClient
      estado="ok"
      paineis={resultado.paineis.map((p) => ({ ...p, atualizadoEmTexto: dataDoPainel(p.atualizado_em, tag, fuso) }))}
    />
  );
}

function CarregandoPaineis() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <Skeleton className="h-9 w-64 max-w-full" />
      <Skeleton className="h-4 w-full max-w-md" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
