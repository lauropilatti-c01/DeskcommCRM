"use client";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { useState } from "react";
import type {
  FlowField,
  SimulationRequest,
  SimulationResult,
  Snapshot,
} from "@/lib/c01/jornadas/contrato";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { pedir } from "./api";
import { formatarData, textoValor } from "./modelo";

type Answer = SimulationRequest["answers"][number];
function opcoes(field: FlowField, data: Record<string, unknown>) {
  if (!field.dynamic) return field.options;
  const candidate = data[field.name] ?? data.opcoes;
  if (!Array.isArray(candidate)) return [];
  return candidate.filter(
    (option): option is { id: string; title: string; description?: string } =>
      typeof option === "object" &&
      option !== null &&
      typeof option.id === "string" &&
      typeof option.title === "string",
  );
}
export default function Cenarios({
  snapshot,
  onPath,
  onShowMap,
}: {
  snapshot: Snapshot;
  onPath: (flowId: string, steps: string[], snapshot: Snapshot) => void;
  onShowMap?: () => void;
}) {
  const t = useT();
  const languageTag = useTagDeIdioma();
  const [pinned, setPinned] = useState<Snapshot | null>(null);
  const [flowId, setFlowId] = useState("");
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [values, setValues] = useState<Record<string, string | string[]>>({});
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const flow = pinned?.flows.find((item) => item.id === flowId);
  const current = result?.steps.at(-1);
  const screen = flow?.screens.find((item) => item.id === current?.screen);
  async function simulate(photo: Snapshot, id: string, entries: Answer[]) {
    setBusy(true);
    setError("");
    try {
      const next = await pedir<SimulationResult>("/simulate", {
        snapshot_id: photo.snapshot_id,
        flow_id: id,
        answers: entries,
      });
      if (next.snapshot_id !== photo.snapshot_id || next.flow_id !== id)
        throw new Error(
          t("O cenário não corresponde à leitura selecionada. Inicie um novo cenário."),
        );
      setPinned(photo);
      setFlowId(id);
      setAnswers(entries);
      setResult(next);
      setValues({});
      onPath(
        id,
        next.steps.map((step) => step.screen),
        photo,
      );
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : t("Não foi possível explorar este cenário."),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <h2 className="text-lg font-semibold">{t("Explore um caminho")}</h2>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-text-muted">
          {t(
            "Use respostas fictícias para acompanhar as perguntas e os dados entregues ao atendimento. Este ensaio não envia mensagens nem chama a Marina.",
          )}
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {snapshot.scenarios.map((scenario) => (
          <button
            key={scenario.id}
            disabled={busy}
            onClick={() => void simulate(snapshot, scenario.flow_id, scenario.answers)}
            className="rounded-lg border border-border bg-surface p-4 text-left transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
          >
            <span className="block text-sm font-semibold">{scenario.title}</span>
            <span className="mt-1 block text-xs leading-5 text-text-muted">
              {scenario.description}
            </span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1 text-sm font-medium" htmlFor="cenario-flow">
          {t("Ou comece pelo formulário")}
          <select
            id="cenario-flow"
            className="mt-2 h-11 w-full rounded border border-border bg-bg px-3 text-sm"
            value={flowId}
            onChange={(event) => {
              setFlowId(event.target.value);
              setPinned(null);
              setResult(null);
              setAnswers([]);
              setError("");
            }}
            disabled={busy}
          >
            <option value="">{t("Selecione um formulário")}</option>
            {snapshot.flows.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.verified ? "" : t(" · Caminhos não conferidos")}
              </option>
            ))}
          </select>
        </label>
        <Button disabled={!flowId || busy} onClick={() => void simulate(snapshot, flowId, [])}>
          {busy ? t("Consultando…") : t("Começar do início")}
        </Button>
      </div>
      {error && (
        <p role="alert" className="rounded border border-error bg-error-bg p-4 text-sm text-text">
          {error}
        </p>
      )}
      {result && pinned && (
        <section
          className="space-y-5 rounded-lg border border-border bg-surface p-4 sm:p-6"
          aria-busy={busy}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold">{flow?.name}</h3>
              <p className="mt-1 text-xs text-text-muted">
                {t("Leitura fixada em")} {formatarData(pinned.captured_at, languageTag)}
              </p>
              {pinned.snapshot_id !== snapshot.snapshot_id && (
                <p className="mt-2 text-sm text-text-muted">
                  {t(
                    "Há uma leitura mais recente. Este cenário continua usando a anterior; comece do início para usar a nova.",
                  )}
                </p>
              )}
            </div>
            <span className="rounded border border-border px-2 py-1 text-xs">
              {result.verified ? t("Percurso conferido") : t("Percurso não conferido")}
            </span>
          </div>
          <ol className="flex flex-wrap gap-2 text-xs" aria-label={t("Percurso do cenário")}>
            {result.steps.map((step, index) => (
              <li key={`${index}:${step.screen}`} className="rounded bg-surface-elevated px-2 py-1">
                {index + 1}. {step.title}
              </li>
            ))}
          </ol>
          {onShowMap && (
            <Button variant="outline" onClick={onShowMap}>
              {t("Ver percurso no mapa")}
            </Button>
          )}
          {current && (
            <div>
              <h4 className="mb-3 text-base font-semibold">{current.title}</h4>
              {Object.entries(current.data)
                .filter(
                  ([key, value]) =>
                    typeof value === "string" &&
                    value &&
                    !["resposta", "flow_token", "receipt"].includes(key),
                )
                .map(([key, value]) => (
                  <p
                    key={key}
                    className={`mb-3 text-sm leading-6 whitespace-pre-wrap ${key === "erro" ? "text-error" : "text-text-muted"}`}
                  >
                    {String(value)}
                  </p>
                ))}
            </div>
          )}
          {screen && (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void simulate(pinned, flowId, [...answers, { screen: screen.id, data: values }]);
              }}
            >
              {screen.fields.map((field) => {
                const options = opcoes(field, current?.data ?? {});
                const rawValue = values[field.name];
                const chosen = Array.isArray(rawValue) ? rawValue : [];
                return (
                  <fieldset key={field.name} className="space-y-2">
                    <legend className="mb-2 text-sm font-medium">
                      {field.label}
                      {field.required ? " *" : ""}
                    </legend>
                    {options.length ? (
                      field.type === "CheckboxGroup" ? (
                        <div className="space-y-2">
                          {options.map((option) => (
                            <label
                              key={option.id}
                              className="flex min-h-11 items-start gap-3 rounded border border-border p-3 text-sm"
                            >
                              <input
                                type="checkbox"
                                className="mt-1 size-4 accent-accent"
                                checked={chosen.includes(option.id)}
                                onChange={(event) => {
                                  const prior = chosen;
                                  setValues({
                                    ...values,
                                    [field.name]: event.target.checked
                                      ? [...prior, option.id]
                                      : prior.filter((value) => value !== option.id),
                                  });
                                }}
                              />
                              <span>
                                {option.title}
                                {option.description && (
                                  <span className="mt-1 block text-xs text-text-muted">
                                    {option.description}
                                  </span>
                                )}
                              </span>
                            </label>
                          ))}
                        </div>
                      ) : (
                        <select
                          aria-label={field.label}
                          required={field.required}
                          className="h-11 w-full rounded border border-border bg-bg px-3 text-sm"
                          value={typeof values[field.name] === "string" ? values[field.name] : ""}
                          onChange={(event) =>
                            setValues({ ...values, [field.name]: event.target.value })
                          }
                        >
                          <option value="">{t("Escolha uma opção")}</option>
                          {options.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.title}
                              {option.description ? ` — ${option.description}` : ""}
                            </option>
                          ))}
                        </select>
                      )
                    ) : field.dynamic ? (
                      <p className="text-sm text-text-muted">
                        {t(
                          "Opções indisponíveis nesta leitura. Não é possível avançar por esta etapa.",
                        )}
                      </p>
                    ) : (
                      <Input
                        aria-label={field.label}
                        required={field.required}
                        maxLength={2000}
                        value={typeof values[field.name] === "string" ? values[field.name] : ""}
                        onChange={(event) =>
                          setValues({ ...values, [field.name]: event.target.value })
                        }
                      />
                    )}
                  </fieldset>
                );
              })}
              <Button
                type="submit"
                disabled={
                  busy ||
                  screen.fields.some(
                    (field) => field.dynamic && !opcoes(field, current?.data ?? {}).length,
                  )
                }
              >
                {busy
                  ? t("Consultando…")
                  : screen.terminal
                    ? t("Simular envio das respostas")
                    : t("Ver próxima etapa")}
              </Button>
              {screen.terminal && (
                <p className="text-xs text-text-muted">{t("Nenhuma mensagem será enviada.")}</p>
              )}
            </form>
          )}
          <div className="border-t border-border pt-4">
            <p className="text-sm font-medium">{t("Resultado")}</p>
            <p className="mt-1 text-sm leading-6 text-text-muted">{result.outcome}</p>
          </div>
          {!!Object.keys(result.fields).length && (
            <details>
              <summary className="cursor-pointer py-2 text-sm font-medium">
                {t("Informações entregues ao atendimento")}
              </summary>
              <dl className="mt-2 divide-y divide-border">
                {Object.entries(result.fields).map(([name, value]) => (
                  <div key={name} className="py-3">
                    <dt className="text-xs font-medium break-words text-text-muted">{name}</dt>
                    <dd className="mt-1 text-sm break-words whitespace-pre-wrap">
                      {textoValor(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
        </section>
      )}
    </div>
  );
}
