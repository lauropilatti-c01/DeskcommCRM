"use client";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { Snapshot } from "@/lib/c01/jornadas/contrato";
import { ConsultaError, pedir } from "./api";
import { buscarEtapas, formatarData, mapaFormulario, telaPorId, type MapNode } from "./modelo";
import { Detalhes, EstadoFormulario } from "./Detalhes";
import Cenarios from "./Cenarios";

function CarregandoMapa() {
  const t = useT();
  return (
    <div
      className="flex min-h-[480px] items-center justify-center text-sm text-text-muted"
      role="status"
    >
      {t("Carregando mapa…")}
    </div>
  );
}
const Mapa = dynamic(() => import("./Mapa"), { ssr: false, loading: CarregandoMapa });

export default function Jornadas({
  initialSnapshot = null,
}: {
  initialSnapshot?: Snapshot | null;
}) {
  const t = useT();
  const languageTag = useTagDeIdioma();
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [busy, setBusy] = useState(!initialSnapshot);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [tab, setTab] = useState("mapa");
  const [query, setQuery] = useState("");
  const [flowId, setFlowId] = useState<string | null>(null);
  const [screenId, setScreenId] = useState<string | null>(null);
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [fullMap, setFullMap] = useState(false);
  const [highlighted, setHighlighted] = useState<string[]>([]);
  const [scenarioSnapshot, setScenarioSnapshot] = useState<Snapshot | null>(null);
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    controller.current?.abort();
    controller.current = new AbortController();
    try {
      const next = await pedir<Snapshot>("", undefined, controller.current.signal);
      if (mounted.current) setSnapshot(next);
    } catch (failure) {
      if (
        mounted.current &&
        failure instanceof ConsultaError &&
        [401, 403, 404].includes(failure.status)
      )
        setSnapshot(null);
      if (mounted.current && !(failure instanceof DOMException && failure.name === "AbortError"))
        setError(
          failure instanceof Error ? failure.message : t("Não foi possível consultar as fontes."),
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [t]);
  useEffect(() => {
    mounted.current = true;
    const params = new URLSearchParams(window.location.search);
    setFlowId(params.get("flow"));
    setScreenId(params.get("etapa"));
    if (!initialSnapshot) void load();
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, [initialSnapshot, load]);

  const mapSnapshot = scenarioSnapshot ?? snapshot;
  const flow = mapSnapshot?.flows.find((item) => item.id === flowId);
  const screen = telaPorId(flow, screenId);
  const node = snapshot?.graph.nodes.find((item) => item.id === nodeId);
  const map = useMemo(
    () => (flow ? mapaFormulario(flow) : (snapshot?.graph ?? { nodes: [], edges: [] })),
    [flow, snapshot],
  );
  const results = useMemo(() => (snapshot ? buscarEtapas(snapshot, query) : []), [snapshot, query]);
  function select(
    nextFlow: string | null,
    nextScreen: string | null = null,
    open = false,
    keepScenario = false,
  ) {
    if (!keepScenario) {
      setScenarioSnapshot(null);
      setHighlighted([]);
    }
    setFlowId(nextFlow);
    setScreenId(nextScreen);
    setNodeId(null);
    setDetailOpen(open && window.matchMedia("(max-width: 1279px)").matches);
    const url = new URL(window.location.href);
    if (nextFlow) url.searchParams.set("flow", nextFlow);
    else url.searchParams.delete("flow");
    if (nextScreen) url.searchParams.set("etapa", nextScreen);
    else url.searchParams.delete("etapa");
    window.history.replaceState(window.history.state, "", url);
  }
  function selectNode(id: string) {
    if (flow) select(flow.id, id, true, Boolean(scenarioSnapshot));
    else {
      setNodeId(id);
      setDetailOpen(window.matchMedia("(max-width: 1279px)").matches);
    }
  }
  async function refresh() {
    setRefreshing(true);
    setError("");
    setNotice("");
    try {
      await pedir<{ accepted: boolean }>("/refresh", {});
      if (mounted.current) {
        setNotice(
          t(
            "Conferência solicitada. A coleta acontece em segundo plano; consulte novamente em alguns instantes.",
          ),
        );
        await load();
      }
    } catch (failure) {
      if (mounted.current)
        setError(
          failure instanceof Error
            ? failure.message
            : t("Não foi possível atualizar a conferência."),
        );
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }
  const detail = snapshot ? (
    <Detalhes
      snapshot={mapSnapshot ?? snapshot}
      flow={flow}
      screen={screen}
      node={node as MapNode | undefined}
      onScreen={(id) => select(flowId, id, true, Boolean(scenarioSnapshot))}
      onFlow={(id) => {
        setTab("mapa");
        select(id);
      }}
    />
  ) : null;
  return (
    <main className="min-w-0 space-y-5 text-text" aria-label={t("Jornadas do atendimento")}>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("Jornadas")}</h1>
          <p className="mt-1 text-sm text-text-muted">
            {t("Do primeiro contato ao atendimento, em um só mapa.")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy || refreshing} onClick={() => void load()}>
            {t("Recarregar leitura")}
          </Button>
          <Button disabled={busy || refreshing} onClick={() => void refresh()}>
            {refreshing ? t("Solicitando…") : t("Atualizar conferência")}
          </Button>
        </div>
      </header>
      {error && (
        <div role="alert" className="rounded-lg border border-error bg-error-bg p-4 text-sm">
          <p className="font-medium">{t("Não foi possível conferir agora")}</p>
          <p className="mt-1">{error}</p>
          {snapshot && (
            <p className="mt-2">
              {t("Os dados abaixo são da última leitura exibida, de")}
              {formatarData(snapshot.captured_at, languageTag)}.
            </p>
          )}
        </div>
      )}
      {notice && (
        <p
          role="status"
          className="rounded-lg border border-border bg-surface-elevated p-3 text-sm leading-6"
        >
          {notice}
        </p>
      )}
      {!snapshot ? (
        <section className="rounded-lg border border-border bg-surface p-10 text-center">
          <p className="font-medium" role="status">
            {busy ? t("Consultando as fontes…") : t("Ainda não há uma leitura disponível")}
          </p>
          <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-text-muted">
            {busy
              ? t("Reunindo os formulários e as regras de entrada.")
              : t(
                  "A página precisa de uma leitura do serviço Jornadas para mostrar o atendimento. Nenhum dado de exemplo substitui a configuração real.",
                )}
          </p>
        </section>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-text-muted">
            <span className="rounded-md border border-border bg-surface px-2 py-1 font-medium text-text">
              {snapshot.environment === "production"
                ? t("Produção")
                : snapshot.environment === "laboratory"
                  ? t("Laboratório")
                  : t("Exemplo fictício")}
            </span>
            <span>
              {t("Leitura de")} {formatarData(snapshot.captured_at, languageTag)}
            </span>
            <span>
              {snapshot.flows.length} {t("formulário(s)")}
            </span>
            <span>
              {snapshot.completeness === "complete"
                ? t("Fontes consultadas")
                : snapshot.completeness === "partial"
                  ? t("Leitura parcial · veja Conferência")
                  : t("Leitura ainda não conferida")}
            </span>
          </div>
          {snapshot.completeness !== "complete" && (
            <p className="rounded-md border border-border bg-surface-elevated p-3 text-sm leading-6">
              {t(
                "Parte das informações não pôde ser confirmada. Os estados desconhecidos continuam visíveis; consulte os detalhes em",
              )}{" "}
              <button
                className="font-medium text-accent underline underline-offset-4"
                onClick={() => setTab("conferencia")}
              >
                {t("Conferência")}
              </button>
              .
            </p>
          )}
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList
              aria-label={t("Visões de Jornadas")}
              className="grid h-auto w-full grid-cols-2 sm:inline-flex sm:w-auto sm:justify-start [&_[data-state=active]]:bg-surface [&_[data-state=active]]:text-text"
            >
              <TabsTrigger value="mapa">{t("Mapa geral")}</TabsTrigger>
              <TabsTrigger value="formularios">{t("Formulários")}</TabsTrigger>
              <TabsTrigger value="cenarios">{t("Cenários")}</TabsTrigger>
              <TabsTrigger value="conferencia">
                {t("Conferência")}
                {snapshot.divergences.length ? ` (${snapshot.divergences.length})` : ""}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="mapa" className="mt-4">
              {scenarioSnapshot && (
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface-elevated p-3">
                  <p className="text-xs leading-5">
                    {t("Etapas destacadas pertencem ao último cenário explorado.")}{" "}
                    {t("Leitura fixada em")}{" "}
                    {formatarData(scenarioSnapshot.captured_at, languageTag)}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setScenarioSnapshot(null);
                      setHighlighted([]);
                    }}
                  >
                    {t("Limpar destaque do cenário")}
                  </Button>
                </div>
              )}
              <div
                className={`overflow-hidden rounded-lg border border-border bg-surface xl:grid ${screen || node ? "xl:grid-cols-[220px_minmax(0,1fr)_320px]" : "xl:grid-cols-[220px_minmax(0,1fr)]"}`}
              >
                <aside
                  className="space-y-4 border-b border-border p-4 xl:max-h-[740px] xl:overflow-y-auto xl:border-r xl:border-b-0"
                  aria-label={t("Inventário de formulários")}
                >
                  <div>
                    <label htmlFor="jornadas-busca" className="text-xs font-medium">
                      {t("Buscar texto ou opção")}
                    </label>
                    <Input
                      id="jornadas-busca"
                      className="mt-2"
                      placeholder={t("Ex.: ensino médio")}
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </div>
                  {query.trim() ? (
                    <div aria-live="polite">
                      <p className="mb-2 text-xs text-text-muted">
                        {results.length} {t("etapa(s) encontrada(s)")}
                      </p>
                      <ul className="space-y-2">
                        {results.map((item) => (
                          <li key={`${item.flow.id}:${item.screen.id}`}>
                            <button
                              className="w-full rounded-md border border-border p-3 text-left text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
                              aria-label={`${item.screen.title} · ${item.flow.name}`}
                              onClick={() => select(item.flow.id, item.screen.id, true)}
                            >
                              <span className="block font-medium">{item.screen.title}</span>
                              <span className="mt-1 block text-xs text-text-muted">
                                {item.flow.name}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <>
                      <button
                        aria-pressed={!flowId}
                        onClick={() => select(null)}
                        className={`w-full rounded-md border p-3 text-left text-sm font-medium ${!flowId ? "border-accent bg-accent-soft" : "border-border"}`}
                      >
                        {t("Todo o atendimento")}
                      </button>
                      <p className="text-xs font-medium tracking-wide text-text-muted uppercase">
                        {t("Formulários")}
                      </p>
                      <ul className="space-y-2">
                        {snapshot.flows.map((item) => (
                          <li key={item.id}>
                            <button
                              aria-pressed={flowId === item.id}
                              onClick={() => select(item.id)}
                              className={`w-full rounded-md border p-3 text-left ${flowId === item.id ? "border-accent bg-accent-soft" : "border-border hover:border-accent"}`}
                            >
                              <span className="block text-sm font-medium break-words">
                                {item.name}
                              </span>
                              <span className="mt-1 block text-xs text-text-muted">
                                {item.screens.length} {t("etapas ·")}{" "}
                                {item.activation === "enabled"
                                  ? t("Habilitado")
                                  : item.activation === "disabled"
                                    ? t("Sem novas entradas")
                                    : t("Ativação desconhecida")}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </aside>
                <section
                  className="min-w-0 xl:max-h-[740px]"
                  aria-label={t("Percurso do atendimento")}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
                    <div>
                      <h2 className="text-sm font-semibold">
                        {flow?.name ?? t("Visão do atendimento")}
                      </h2>
                      <p className="mt-1 text-xs text-text-muted">
                        {t("Linhas tracejadas: caminho ainda não conferido.")}
                      </p>
                    </div>
                    {flow && (
                      <Button variant="ghost" size="sm" onClick={() => select(null)}>
                        {t("Voltar ao geral")}
                      </Button>
                    )}
                  </div>
                  <div className="hidden h-[590px] lg:block">
                    <Mapa
                      key={flowId ?? "geral"}
                      nodes={map.nodes}
                      edges={map.edges}
                      selected={screenId ?? nodeId}
                      highlighted={highlighted}
                      onSelect={selectNode}
                    />
                  </div>
                  <div className="p-4 lg:hidden">
                    <Button
                      variant="outline"
                      className="mb-4 w-full"
                      onClick={() => setFullMap(true)}
                    >
                      {t("Abrir mapa em tela cheia")}
                    </Button>
                    <ol className="space-y-2">
                      {map.nodes.map((item, index) => (
                        <li key={item.id}>
                          <button
                            onClick={() => selectNode(item.id)}
                            className="w-full rounded-md border border-border p-3 text-left text-sm focus-visible:outline-2 focus-visible:outline-accent"
                          >
                            <span className="mr-2 text-text-muted">{index + 1}.</span>
                            {item.label}
                            <span className="mt-1 block text-xs text-text-muted">
                              {item.detail}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ol>
                  </div>
                  <details className="hidden border-t border-border p-4 lg:block">
                    <summary className="cursor-pointer text-xs font-medium">
                      {t("Navegar por lista de etapas")}
                    </summary>
                    <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                      {map.nodes.map((item) => (
                        <li key={item.id}>
                          <button
                            className="min-h-9 w-full rounded-md px-2 text-left text-xs hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-accent"
                            onClick={() => selectNode(item.id)}
                          >
                            {item.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </details>
                  {!map.nodes.length && (
                    <p className="p-6 text-sm text-text-muted">
                      {t("Nenhuma etapa disponível nesta leitura.")}
                    </p>
                  )}
                </section>
                {(screen || node) && (
                  <aside
                    className="hidden max-h-[740px] overflow-y-auto border-l border-border xl:block"
                    aria-label={t("Detalhes da etapa")}
                  >
                    {detail}
                  </aside>
                )}
              </div>
            </TabsContent>
            <TabsContent value="formularios" className="mt-4">
              <div className="grid gap-4 md:grid-cols-2">
                {snapshot.flows.map((item) => (
                  <article
                    key={item.id}
                    className="space-y-4 rounded-lg border border-border bg-surface p-5"
                  >
                    <div>
                      <h2 className="text-base font-semibold break-words">{item.name}</h2>
                      <p className="mt-1 text-xs text-text-muted">
                        {item.screens.length} {t("etapas · Identificador")} {item.id}
                      </p>
                    </div>
                    <EstadoFormulario flow={item} />
                    <p className="text-sm leading-6">
                      {item.audience || t("Público não identificado nesta leitura.")}
                    </p>
                    <p className="text-xs text-text-muted">
                      {item.verified
                        ? t("Caminhos reconhecidos pelo leitor.")
                        : t("Caminhos ainda não conferidos para esta versão.")}
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setTab("mapa");
                        select(item.id, item.entry_screen);
                      }}
                    >
                      {t("Abrir formulário no mapa")}
                    </Button>
                  </article>
                ))}
              </div>
              {!snapshot.flows.length && (
                <p className="p-6 text-sm text-text-muted">
                  {t("O inventário não retornou formulários. Confira o estado da fonte Meta.")}
                </p>
              )}
            </TabsContent>
            <TabsContent
              forceMount
              value="cenarios"
              hidden={tab !== "cenarios"}
              className="mt-4 rounded-lg border border-border bg-surface data-[state=inactive]:hidden"
            >
              <Cenarios
                snapshot={snapshot}
                onShowMap={() => setTab("mapa")}
                onPath={(id, steps, photo) => {
                  setHighlighted(steps);
                  setScenarioSnapshot(photo);
                  select(id, steps.at(-1) ?? null, false, true);
                }}
              />
            </TabsContent>
            <TabsContent value="conferencia" className="mt-4 space-y-5">
              <section className="rounded-lg border border-border bg-surface p-5">
                <h2 className="text-lg font-semibold">{t("Fontes desta leitura")}</h2>
                <p className="mt-1 text-sm text-text-muted">
                  {t(
                    "Cada origem é conferida separadamente. Publicar na Meta não habilita o formulário no atendimento.",
                  )}
                </p>
                <div className="mt-5 divide-y divide-border">
                  {snapshot.sources.map((source) => (
                    <div
                      key={source.id}
                      className="flex flex-wrap items-start justify-between gap-3 py-4"
                    >
                      <div className="min-w-0 flex-1">
                        <h3 className="text-sm font-medium">{source.label}</h3>
                        <p className="mt-1 text-xs text-text-muted">
                          {formatarData(source.checked_at, languageTag)}
                          {source.version ? ` · Versão ${source.version}` : ""}
                        </p>
                        {source.message && (
                          <p className="mt-2 text-sm leading-6 break-words">{source.message}</p>
                        )}
                      </div>
                      <span className="rounded-md border border-border px-2 py-1 text-xs">
                        {source.status === "ok"
                          ? t("Consultada")
                          : source.status === "error"
                            ? t("Não foi possível conferir")
                            : t("Não conferida")}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
              <section className="rounded-lg border border-border bg-surface p-5">
                <h2 className="text-lg font-semibold">{t("Pontos de atenção")}</h2>
                {snapshot.divergences.length ? (
                  <ul className="mt-4 divide-y divide-border">
                    {snapshot.divergences.map((item) => (
                      <li key={item.id} className="space-y-2 py-4">
                        <p className="text-xs font-medium text-text-muted">
                          {item.severity === "error"
                            ? t("Erro")
                            : item.severity === "warning"
                              ? t("Atenção")
                              : t("Informação")}
                        </p>
                        <h3 className="text-sm font-semibold">{item.title}</h3>
                        <p className="text-sm leading-6">{item.detail}</p>
                        {item.flow_id && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setTab("mapa");
                              select(
                                item.flow_id!,
                                item.screen_id ?? null,
                                Boolean(item.screen_id),
                              );
                            }}
                          >
                            {t("Ver etapa relacionada")}
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 text-sm text-text-muted">
                    {t(
                      "Nenhuma divergência relatada pelas fontes consultadas. Isso não substitui a conferência das fontes indisponíveis.",
                    )}
                  </p>
                )}
              </section>
            </TabsContent>
          </Tabs>
          <Sheet open={detailOpen && !fullMap} onOpenChange={setDetailOpen}>
            <SheetContent className="w-full overflow-y-auto sm:max-w-md xl:hidden">
              <SheetHeader className="sr-only">
                <SheetTitle>{t("Detalhes da etapa")}</SheetTitle>
                <SheetDescription>{t("Textos, opções e próximos destinos.")}</SheetDescription>
              </SheetHeader>
              {detail}
            </SheetContent>
          </Sheet>
          <Sheet open={fullMap} onOpenChange={setFullMap}>
            <SheetContent side="bottom" className="h-[95dvh] p-0">
              <SheetHeader className="p-4 pr-12">
                <SheetTitle>{flow?.name ?? t("Mapa do atendimento")}</SheetTitle>
                <SheetDescription>
                  {t("Toque em uma etapa para abrir seus detalhes.")}
                </SheetDescription>
              </SheetHeader>
              <div className="h-[calc(95dvh-110px)]">
                <Mapa
                  key={`fullscreen:${flowId}`}
                  nodes={map.nodes}
                  edges={map.edges}
                  selected={screenId ?? nodeId}
                  highlighted={highlighted}
                  onSelect={(id) => {
                    selectNode(id);
                    setFullMap(false);
                  }}
                />
              </div>
            </SheetContent>
          </Sheet>
        </>
      )}
    </main>
  );
}
