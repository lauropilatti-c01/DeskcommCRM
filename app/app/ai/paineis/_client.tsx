"use client";
/**
 * (C01, -c01.7) Painéis da operação, só leitura: uma aba por painel que o serviço do
 * gancho manda (`lib/ai/paineis`). Todo o conteúdo vem do serviço; aqui só há o
 * desenho e a busca dentro da aba.
 *
 * Texto do serviço é sempre texto puro, com as quebras de linha preservadas
 * (`whitespace-pre-wrap`): nada de HTML nem markdown.
 */
import { useRouter } from "next/navigation";
import * as React from "react";

import { EmptyState } from "@/components/empty";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useT } from "@/hooks/i18n/useT";
import type { EstadoSemPaineis, MensagemPronta, Painel, SecaoDoPainel } from "@/lib/ai/paineis/contrato";
import { Eye, Info, MagnifyingGlass, WarningOctagon } from "@/lib/ui/icons";

/** O painel com a data já formatada no servidor (idioma e fuso de quem olha). */
export type PainelNaTela = Painel & { atualizadoEmTexto: string | null };

export type PaineisProps =
  | { estado: "ok"; paineis: PainelNaTela[] }
  | { estado: EstadoSemPaineis; paineis?: undefined };

/** Minúsculas e sem acento, para "enfase" achar "ênfase". */
function normalizar(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function contem(alvo: string, busca: string): boolean {
  return normalizar(alvo).includes(busca);
}

/** A seção como fica com a busca: inteira se o título ou o texto batem, senão só o que bate. */
function filtrarSecao(secao: SecaoDoPainel, busca: string): SecaoDoPainel | null {
  if (busca === "") return secao;
  if (contem(secao.titulo, busca) || contem(secao.texto, busca)) return secao;
  if (secao.tipo === "mensagens") {
    const mensagens = secao.mensagens.filter((m) =>
      [m.rotulo, m.quando, m.texto, m.botao].some((campo) => contem(campo, busca)),
    );
    return mensagens.length > 0 ? { ...secao, mensagens } : null;
  }
  if (secao.tipo === "tabela") {
    const linhas = secao.linhas.filter((linha) => linha.some((celula) => contem(celula, busca)));
    return linhas.length > 0 ? { ...secao, linhas } : null;
  }
  return null;
}

const TEXTO_DO_SERVICO = "whitespace-pre-wrap break-words [overflow-wrap:anywhere]";

function CartaoDaMensagem({ mensagem }: { mensagem: MensagemPronta }) {
  const t = useT();
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-md border border-border bg-surface-elevated p-3">
      {mensagem.rotulo || mensagem.quando ? (
        <div className="flex min-w-0 flex-col gap-0.5">
          {mensagem.rotulo ? <p className={`text-sm font-semibold text-text ${TEXTO_DO_SERVICO}`}>{mensagem.rotulo}</p> : null}
          {mensagem.quando ? (
            <p className={`text-xs text-text-muted ${TEXTO_DO_SERVICO}`}>
              {t("Quando")}: {mensagem.quando}
            </p>
          ) : null}
        </div>
      ) : null}
      {mensagem.texto ? <p className={`text-sm leading-relaxed text-text ${TEXTO_DO_SERVICO}`}>{mensagem.texto}</p> : null}
      {mensagem.botao ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-xs text-text-muted">{t("Botão")}:</span>
          <span
            className={`rounded-md border border-border bg-surface px-2 py-1 text-xs font-medium text-text ${TEXTO_DO_SERVICO}`}
          >
            {mensagem.botao}
          </span>
        </div>
      ) : null}
    </li>
  );
}

function TabelaDaSecao({ colunas, linhas }: { colunas: string[]; linhas: string[][] }) {
  const largura = Math.max(colunas.length, ...linhas.map((l) => l.length));
  const indices = Array.from({ length: largura }, (_, i) => i);
  return (
    <>
      {/* Celular: cada linha vira um bloco com "coluna: valor", sem rolagem para o lado. */}
      <ul className="flex flex-col gap-2 md:hidden">
        {linhas.map((linha, i) => (
          <li key={i} className="rounded-md border border-border bg-surface-elevated p-3">
            <dl className="flex flex-col gap-2">
              {indices.map((c) => (
                <div key={c} className="min-w-0">
                  {colunas[c] ? <dt className="text-xs text-text-muted">{colunas[c]}</dt> : null}
                  <dd className={`text-sm text-text ${c === 0 ? "font-semibold" : ""} ${TEXTO_DO_SERVICO}`}>
                    {linha[c] ?? ""}
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
      <div className="hidden md:block">
        <Table>
          {colunas.length > 0 ? (
            <TableHeader>
              <TableRow>
                {indices.map((c) => (
                  <TableHead key={c} className="h-auto py-2 align-bottom">
                    {colunas[c] ?? ""}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
          ) : null}
          <TableBody>
            {linhas.map((linha, i) => (
              <TableRow key={i}>
                {indices.map((c) => (
                  <TableCell key={c} className={`min-w-32 align-top ${TEXTO_DO_SERVICO}`}>
                    {linha[c] ?? ""}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

function SecaoNaTela({ secao }: { secao: SecaoDoPainel }) {
  const t = useT();
  if (secao.tipo === "desconhecido") {
    return (
      <p className="flex items-start gap-2 text-xs text-text-muted">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span className={TEXTO_DO_SERVICO}>
          {secao.titulo
            ? t("A seção “{titulo}” é de um tipo que esta tela ainda não mostra.").replace("{titulo}", secao.titulo)
            : t("Uma seção deste painel é de um tipo que esta tela ainda não mostra.")}
        </span>
      </p>
    );
  }
  const vazia = secao.tipo === "mensagens" ? secao.mensagens.length === 0 : secao.linhas.length === 0;
  return (
    <Card>
      {secao.titulo || secao.texto ? (
        <CardHeader className="p-4 pb-2 md:p-5 md:pb-3">
          {secao.titulo ? <CardTitle className={TEXTO_DO_SERVICO}>{secao.titulo}</CardTitle> : null}
          {secao.texto ? <CardDescription className={TEXTO_DO_SERVICO}>{secao.texto}</CardDescription> : null}
        </CardHeader>
      ) : null}
      <CardContent className={secao.titulo || secao.texto ? "p-4 pt-2 md:p-5 md:pt-2" : "p-4 md:p-5"}>
        {vazia ? (
          <p className="text-sm text-text-muted">{t("Nada nesta seção.")}</p>
        ) : secao.tipo === "mensagens" ? (
          <ul className="grid gap-3 xl:grid-cols-2">
            {secao.mensagens.map((m, i) => (
              <CartaoDaMensagem key={i} mensagem={m} />
            ))}
          </ul>
        ) : (
          <TabelaDaSecao colunas={secao.colunas} linhas={secao.linhas} />
        )}
      </CardContent>
    </Card>
  );
}

function ConteudoDoPainel({ painel, busca }: { painel: PainelNaTela; busca: string }) {
  const t = useT();
  const termo = normalizar(busca.trim());
  const secoes = painel.secoes
    .map((s) => filtrarSecao(s, termo))
    .filter((s): s is SecaoDoPainel => s !== null);

  if (painel.secoes.length === 0) {
    return <p className="text-sm text-text-muted">{t("Este painel ainda não tem nada para mostrar.")}</p>;
  }
  if (secoes.length === 0) {
    return (
      <p className={`text-sm text-text-muted ${TEXTO_DO_SERVICO}`}>
        {t("Nada nesta aba tem “{busca}”.").replace("{busca}", busca.trim())}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {secoes.map((s, i) => (
        <SecaoNaTela key={i} secao={s} />
      ))}
    </div>
  );
}

const ERROS: ReadonlySet<EstadoSemPaineis> = new Set(["recusado", "indisponivel", "formato", "grande_demais"]);

function SemPaineis({ estado }: { estado: EstadoSemPaineis | "vazio" }) {
  const t = useT();
  const router = useRouter();
  const frase: Record<EstadoSemPaineis | "vazio", string> = {
    desligado: t(
      "Nenhum sistema está conectado ao agente nesta instalação; quando estiver, os painéis que ele mandar aparecem aqui.",
    ),
    sem_paineis: t("O sistema conectado ao agente não oferece painéis."),
    recusado: t("O sistema conectado recusou a consulta porque a assinatura não confere dos dois lados."),
    indisponivel: t("O sistema conectado não respondeu a tempo; tente de novo em alguns instantes."),
    formato: t("O sistema conectado respondeu num formato que esta tela não sabe ler."),
    grande_demais: t("A resposta do sistema conectado passou do tamanho que esta tela aceita."),
    vazio: t("O sistema conectado ainda não mandou nenhum painel."),
  };
  const erro = estado !== "vazio" && ERROS.has(estado);
  return (
    <EmptyState
      icon={erro ? WarningOctagon : Eye}
      headline={erro ? t("Não deu para carregar os painéis") : t("Nenhum painel para mostrar")}
      subcopy={frase[estado]}
      // Só o serviço que não respondeu a tempo pode responder na próxima; assinatura e formato
      // errados não mudam com um clique.
      primary={estado === "indisponivel" ? { label: t("Tentar de novo"), onClick: () => router.refresh() } : undefined}
    />
  );
}

export function PaineisClient(props: PaineisProps) {
  const t = useT();
  const [aba, setAba] = React.useState("0");
  const [busca, setBusca] = React.useState("");

  if (props.estado !== "ok") return <SemPaineis estado={props.estado} />;
  if (props.paineis.length === 0) return <SemPaineis estado="vazio" />;

  return (
    <Tabs
      value={aba}
      onValueChange={(v) => {
        setAba(v);
        setBusca("");
      }}
      className="flex min-w-0 flex-col gap-4"
    >
      {/* `justify-start`: centralizada, a fila de abas que passa da largura perde o começo. */}
      <TabsList className="h-auto justify-start self-start">
        {props.paineis.map((p, i) => (
          <TabsTrigger key={i} value={String(i)}>
            {p.titulo || t("Painel sem título")}
          </TabsTrigger>
        ))}
      </TabsList>
      {props.paineis.map((p, i) => (
        <TabsContent key={i} value={String(i)} className="mt-0 flex min-w-0 flex-col gap-4">
          {p.descricao || p.atualizadoEmTexto ? (
            <div className="flex flex-col gap-1">
              {p.descricao ? <p className={`text-sm text-text-muted ${TEXTO_DO_SERVICO}`}>{p.descricao}</p> : null}
              {p.atualizadoEmTexto ? (
                <p className="text-xs text-text-muted">
                  {t("Atualizado em {data}").replace("{data}", p.atualizadoEmTexto)}
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="relative w-full sm:max-w-sm">
            <MagnifyingGlass
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
            />
            <Input
              type="search"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder={t("Buscar nesta aba")}
              aria-label={t("Buscar nesta aba")}
              className="pl-9"
            />
          </div>
          <ConteudoDoPainel painel={p} busca={busca} />
        </TabsContent>
      ))}
    </Tabs>
  );
}
