"use client";
import { useT } from "@/hooks/i18n/useT";
import type { Flow, Screen, Snapshot } from "@/lib/c01/jornadas/contrato";
import { Button } from "@/components/ui/button";
import { activationLabels, metaLabels, type MapNode } from "./modelo";

export function EstadoFormulario({ flow }: { flow: Flow }) {
  const t = useT();
  return (
    <div className="flex flex-wrap gap-2 text-xs leading-5">
      <span className="rounded-md border border-border bg-surface-elevated px-2 py-0.5">
        {t(metaLabels[flow.status])}
      </span>
      <span
        className={`rounded-md border px-2 py-0.5 ${flow.activation === "enabled" ? "border-accent bg-accent-soft text-text" : "border-border text-text-muted"}`}
      >
        {t(activationLabels[flow.activation])}
      </span>
    </div>
  );
}

export function Detalhes({
  snapshot,
  flow,
  screen,
  node,
  onScreen,
  onFlow,
}: {
  snapshot: Snapshot;
  flow?: Flow;
  screen?: Screen;
  node?: MapNode;
  onScreen: (id: string) => void;
  onFlow: (id: string) => void;
}) {
  const t = useT();
  if (!screen && !node)
    return (
      <div className="p-6 text-sm leading-6 text-text-muted">
        <p className="font-medium text-text">{t("Abra uma etapa")}</p>
        <p className="mt-2">
          {t(
            "Selecione uma caixa do mapa ou uma etapa da lista para consultar os textos e os destinos de cada opção.",
          )}
        </p>
      </div>
    );
  if (node && !screen)
    return (
      <div className="space-y-5 p-5">
        <div>
          <p className="text-xs text-text-muted">{t("Etapa do atendimento")}</p>
          <h2 className="mt-1 text-lg font-semibold">{node.label}</h2>
        </div>
        {node.detail && <p className="text-sm leading-6 whitespace-pre-wrap">{node.detail}</p>}
        {node.flow_id && (
          <Button variant="outline" className="w-full" onClick={() => onFlow(node.flow_id!)}>
            {t("Abrir telas do formulário")}
          </Button>
        )}
        {node.kind === "agent" && (
          <section className="space-y-3 text-sm">
            <p>
              {t(
                "A resposta varia conforme as informações recebidas. O mapa apresenta as orientações disponíveis, sem gerar uma nova conversa.",
              )}
            </p>
            {snapshot.agent ? (
              <>
                <p className="font-medium">
                  {snapshot.agent.name}
                  {t("· versão")}
                  {snapshot.agent.version}
                </p>
                <details>
                  <summary className="cursor-pointer py-2 font-medium">
                    {t("Ver instruções publicadas")}
                  </summary>
                  <p className="mt-3 text-xs leading-6 break-words whitespace-pre-wrap">
                    {snapshot.agent.instructions}
                  </p>
                </details>
              </>
            ) : (
              <p className="text-text-muted">
                {t("Instruções publicadas indisponíveis nesta leitura.")}
              </p>
            )}
          </section>
        )}
        <div>
          <h3 className="text-sm font-semibold">{t("Próximos destinos")}</h3>
          {snapshot.graph.edges
            .filter((edge) => edge.source === node.id)
            .map((edge) => (
              <div key={edge.id} className="mt-3 rounded-md border border-border p-3 text-sm">
                <p>{edge.label}</p>
                <p className="mt-1 text-text-muted">
                  →{" "}
                  {snapshot.graph.nodes.find((item) => item.id === edge.target)?.label ??
                    edge.target}
                </p>
                {!edge.verified && (
                  <p className="mt-1 text-xs text-text-muted">{t("Caminho ainda não conferido")}</p>
                )}
              </div>
            ))}
        </div>
      </div>
    );
  if (!screen || !flow) return null;
  return (
    <div className="space-y-6 p-5">
      <div>
        <p className="text-xs text-text-muted">{flow.name}</p>
        <h2 className="mt-1 text-lg font-semibold">{screen.title}</h2>
      </div>
      <EstadoFormulario flow={flow} />
      <section>
        <h3 className="text-sm font-semibold">{t("Prévia do conteúdo")}</h3>
        <p className="mt-1 text-xs leading-5 text-text-muted">
          {t("Representação das perguntas. A aparência final é definida pelo WhatsApp.")}
        </p>
        <div className="mt-3 space-y-5 rounded-lg border border-border bg-bg p-4">
          {screen.texts.map((text, index) => (
            <p key={index} className="text-sm leading-6 break-words whitespace-pre-wrap">
              {text.includes("${data.") ? (
                <span className="text-text-muted">{t("Mensagem conforme as respostas.")}</span>
              ) : (
                text
              )}
            </p>
          ))}
          {screen.fields.map((field) => (
            <div key={field.name} className="space-y-2">
              <p className="text-sm font-medium">
                {field.label}
                {field.required && <span className="ml-1 text-text-muted">*</span>}
              </p>
              {field.condition && (
                <p className="text-xs text-text-muted">
                  {t("Aparece quando:")}
                  {field.condition}
                </p>
              )}
              {field.options.length ? (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {field.options.map((option) => (
                    <li key={option.id} className="p-3 text-sm">
                      <p>{option.title}</p>
                      {option.description && (
                        <p className="mt-1 text-xs leading-5 text-text-muted">
                          {option.description}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="rounded-md border border-dashed border-border p-3 text-xs leading-5 text-text-muted">
                  {field.dynamic
                    ? t(
                        "Opções consultadas conforme as respostas. Explore um cenário para ver os resultados.",
                      )
                    : t("Resposta preenchida pela pessoa.")}
                </div>
              )}
            </div>
          ))}
          {screen.terminal && (
            <p className="text-sm font-medium">{t("Conclusão e envio das respostas")}</p>
          )}
        </div>
      </section>
      <details className="text-xs text-text-muted">
        <summary className="cursor-pointer py-2">{t("Referência técnica")}</summary>
        <p className="mt-2 break-words">{screen.id}</p>
        {screen.texts
          .filter((text) => text.includes("${data."))
          .map((text, index) => (
            <p key={index} className="mt-2 break-words">
              {text}
            </p>
          ))}
      </details>
      <section>
        <h3 className="text-sm font-semibold">{t("Para onde vai")}</h3>
        <div className="mt-2 space-y-2">
          {screen.next.map((edge, index) => (
            <Button
              key={`${edge.target}:${index}`}
              variant="outline"
              className="h-auto min-h-11 w-full justify-start px-3 py-3 text-left whitespace-normal"
              onClick={() => onScreen(edge.target)}
              disabled={!flow.screens.some((item) => item.id === edge.target)}
            >
              <span>
                <span className="block">{edge.label || t("Continuar")}</span>
                <span className="mt-1 block text-xs font-normal text-text-muted">
                  → {flow.screens.find((item) => item.id === edge.target)?.title ?? edge.target}
                  {!edge.verified && t(" · Não conferido")}
                </span>
                {edge.condition && (
                  <span className="mt-1 block text-xs font-normal">{edge.condition}</span>
                )}
              </span>
            </Button>
          ))}
          {!screen.next.length && (
            <p className="text-sm text-text-muted">
              {screen.terminal
                ? t("Fim deste formulário.")
                : t("Destino não identificado nesta leitura.")}
            </p>
          )}
        </div>
      </section>
      {!!screen.fields.length && (
        <section>
          <h3 className="text-sm font-semibold">{t("Informações desta etapa")}</h3>
          <p className="mt-1 text-xs text-text-muted">
            {t("Campos coletados; consulte o cenário para ver o que é entregue ao CRM.")}
          </p>
          <ul className="mt-2 space-y-2 text-sm">
            {screen.fields.map((field) => (
              <li key={field.name}>
                {field.label} <span className="text-xs text-text-muted">({field.name})</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
