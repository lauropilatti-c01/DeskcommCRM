export class ConsultaError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function pedir<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v1/c01/jornadas${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const json = (await response.json().catch(() => null)) as {
    data?: T;
    error?: { message?: string };
  } | null;
  if (!response.ok)
    throw new ConsultaError(
      json?.error?.message ?? "Não foi possível consultar Jornadas. Tente novamente.",
      response.status,
    );
  if (!json || !("data" in json))
    throw new Error("O serviço retornou uma leitura incompleta. Tente novamente.");
  return json.data as T;
}
