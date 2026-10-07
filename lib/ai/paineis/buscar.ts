/**
 * (C01, -c01.7) Busca os painéis da operação no serviço do gancho antes do turno.
 *
 * Só no servidor: o segredo da assinatura nunca vai ao navegador. Usa a MESMA
 * configuração do gancho (`AGENT_PRE_TURN_HOOK_URL` e `AGENT_PRE_TURN_HOOK_SECRET`,
 * pela mesma regra do turno, `ganchoAntesDoTurnoDoAmbiente`) e a MESMA assinatura
 * (`assinaturaDoGancho`, corpo vazio):
 *
 *   GET <URL do gancho>/paineis
 *   X-Hook-Signature: t=<unix>,v1=<hex HMAC-SHA256(segredo, "<t>.")>
 *
 * Nada aqui muda o turno do agente: é uma leitura à parte, feita quando alguém abre
 * a tela. Prazo de 5 s e resposta de até 2 MB. Qualquer falha vira um estado que a
 * tela explica numa frase; o log leva só o código do motivo, nunca URL, segredo ou
 * corpo.
 */
import "server-only";

import { assinaturaDoGancho, ganchoAntesDoTurnoDoAmbiente } from "@/lib/agent-engine/agent/gancho-antes-do-turno";
import { logger } from "@/lib/logger";

import { lerPaineis, type EstadoSemPaineis, type Painel } from "./contrato";

export type { EstadoSemPaineis };

export const PRAZO_DOS_PAINEIS_MS = 5_000;
export const TETO_DA_RESPOSTA_DOS_PAINEIS = 2 * 1024 * 1024;

export interface ConfigDosPaineis {
  url: string;
  segredo: string;
}

export type ResultadoDosPaineis = { estado: "ok"; paineis: Painel[] } | { estado: EstadoSemPaineis };

/** `<URL do gancho>/paineis`, sem barra dobrada e sem perder parâmetros. */
export function urlDosPaineis(urlDoGancho: string): string {
  const u = new URL(urlDoGancho);
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/paineis`;
  return u.toString();
}

/**
 * A configuração a partir do ambiente, pela regra do turno: vazio vale ausente (como
 * o `loadEnv` do motor), URL `http(s)` válida e segredo juntos. Sem um dos dois,
 * `null`: a tela mostra o estado `desligado`.
 */
export function configDosPaineis(
  source: Readonly<Record<string, string | undefined>> = process.env,
): ConfigDosPaineis | null {
  const valor = (v: string | undefined) => {
    const t = v?.trim();
    return t ? t : undefined;
  };
  const { ganchoAntesDoTurno } = ganchoAntesDoTurnoDoAmbiente({
    AGENT_PRE_TURN_HOOK_URL: valor(source.AGENT_PRE_TURN_HOOK_URL),
    AGENT_PRE_TURN_HOOK_SECRET: valor(source.AGENT_PRE_TURN_HOOK_SECRET),
    AGENT_PRE_TURN_HOOK_TIMEOUT_MS: PRAZO_DOS_PAINEIS_MS,
  });
  if (!ganchoAntesDoTurno) return null;
  return { url: urlDosPaineis(ganchoAntesDoTurno.url), segredo: ganchoAntesDoTurno.segredo };
}

/** Lê o corpo até o teto; passou, `null` (e a leitura é cancelada). */
async function corpoAteOTeto(res: Response, teto: number): Promise<string | null> {
  const declarado = Number(res.headers.get("content-length"));
  if (Number.isFinite(declarado) && declarado > teto) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return "";
  const leitor = res.body.getReader();
  const pedacos: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > teto) {
      await leitor.cancel().catch(() => {});
      return null;
    }
    pedacos.push(value);
  }
  const junto = new Uint8Array(total);
  let pos = 0;
  for (const p of pedacos) {
    junto.set(p, pos);
    pos += p.byteLength;
  }
  return new TextDecoder("utf-8").decode(junto);
}

const eTimeout = (err: unknown): boolean =>
  err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");

export async function buscarPaineis(
  config: ConfigDosPaineis,
  opts: {
    agoraUnix?: () => number;
    fetchImpl?: typeof fetch;
    prazoMs?: number;
    tetoBytes?: number;
  } = {},
): Promise<ResultadoDosPaineis> {
  const agoraUnix = opts.agoraUnix ?? (() => Math.floor(Date.now() / 1000));
  const fazer = opts.fetchImpl ?? fetch;
  const falha = (estado: EstadoSemPaineis, motivo: string, status?: number): ResultadoDosPaineis => {
    logger.warn("painéis da operação: sem painéis para mostrar", { estado, motivo, ...(status ? { status } : {}) });
    return { estado };
  };

  let res: Response;
  try {
    res = await fazer(config.url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Hook-Signature": assinaturaDoGancho(config.segredo, "", agoraUnix()),
      },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(opts.prazoMs ?? PRAZO_DOS_PAINEIS_MS),
    });
  } catch (err) {
    return falha("indisponivel", eTimeout(err) ? "prazo" : "rede");
  }

  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return falha("sem_paineis", "nao_encontrado", res.status);
  }
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => {});
    return falha("recusado", "assinatura", res.status);
  }
  if (res.status < 200 || res.status > 299) {
    await res.body?.cancel().catch(() => {});
    return falha("indisponivel", "status", res.status);
  }

  let corpo: string | null;
  try {
    corpo = await corpoAteOTeto(res, opts.tetoBytes ?? TETO_DA_RESPOSTA_DOS_PAINEIS);
  } catch (err) {
    return falha("indisponivel", eTimeout(err) ? "prazo" : "rede");
  }
  if (corpo === null) return falha("grande_demais", "teto");

  let json: unknown;
  try {
    json = JSON.parse(corpo);
  } catch {
    return falha("formato", "json_invalido");
  }
  const lido = lerPaineis(json);
  if (!lido) return falha("formato", "raiz_nao_e_objeto");
  return { estado: "ok", paineis: lido.paineis };
}
