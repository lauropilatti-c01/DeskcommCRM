/**
 * (C01, -c01.3, item 3b) TRAVA "VALOR EM DINHEIRO": NENHUM VALOR DO CURSO NA CONVERSA.
 *
 * A regra da C01 (M1 do `docs/comercial/04`, 30/09): valor, parcela, juros e desconto
 * ficam na página de matrícula; a conversa manda a página, sem número de dinheiro. Só o
 * texto pedia isso, e o modelo escrevia parcela e preço (na forma "18x de R$ 157,30")
 * assim mesmo (C10, C41).
 *
 * Ligada por organização (a decisão do Lauro pode mudar), a trava veta:
 * - o que `extractPromises` já lê (R$, reais, euro, desconto em %, "em 12x", "12x sem
 *   juros");
 * - as formas que escapavam e que a régua do laboratório pega (`DINHEIRO_M1` de
 *   `lab/simulacao/raio_x.py`): "18x 157,30", "18 vezes de", "parcelas de", "mensais",
 *   "no Pix", "à vista", "entrada de", "em até 18x", "uns 3 mil", "juros".
 *
 * Não pega: data, "2 fases", "60 metas", "67 dias", "12 meses", "6/12", "14x14" (escala),
 * vaga, "100% online", "30% das vagas", "3 mil questões" — o "%" só conta com desconto
 * ou "off"; o "mil" não conta antes de questões, inscritos, vagas e afins. O salário e
 * os benefícios do cargo (fato da base que a régua isenta) também passam: o valor logo
 * depois de "salário", "remuneração", "benefício"… na mesma frase não conta — só ele
 * (rodada 2): a isenção acaba no primeiro número depois da palavra e em qualquer palavra
 * de oferta ("curso", "matrícula", "custa"…). (Rodada 3) E só o valor ligado DIRETO à
 * expressão do cargo ("salário inicial é de R$ …", "piso salarial de …"), nunca numa
 * frase com palavra de pagamento ou do curso ("Pix", "à vista", "boleto", "plano"…).
 *
 * Trava de CONTEÚDO: contador e fail-safe da promessa semântica
 * (`TRAVAS_DE_CONTEUDO_COM_FAIL_SAFE` em `inbound-turn.ts`).
 */
import type { Gate } from './before-send';
import { linksNoTexto } from './link-permitido';
import { extractPromises } from './promise/engine';

/** As formas da M1 que `extractPromises` não lê, sobre o texto em minúsculas e sem acento. */
const FORMAS_DA_M1: readonly RegExp[] = [
  /r\$\s?\d/g,
  /\b\d[\d.,]*\s?(?:mil\s?)?(?:reais|real)\b/g,
  /\b\d+\s?(?:x|vezes)\s?de\s?(?:r\$\s?)?\d/g,
  /\b\d+\s?x\s+(?:r\$\s?)?\d/g,
  /\bem ate \d+\s?(?:x|vezes)\b/g,
  /\b\d[\d.,]*\s?(?:por|ao) mes\b/g,
  /\b\d[\d.,]*\s?%\s?(?:ao|por) (?:mes|ano)\b/g,
  /\b\d[\d.,]*\s?mensais\b/g,
  /\bjuros\b/g,
  /\b\d+\s?parcelas?\b/g,
  /\bparcelas? de\s?\d/g,
  /\ba vista (?:fica|sai|e|por)\s?\d/g,
  /\b\d[\d.,]*\s?a vista\b/g,
  /\b\d[\d.,]*\s?(?:no|pelo|via) pix\b/g,
  /\bentrada de\s?\d/g,
  /\b\d+\s?mil\b(?!\s?(?:questoes|exercicios|alunos|alunas|aprovados|aprovadas|inscritos|inscritas|candidatos|candidatas|concorrentes|estudantes|usuarios|pessoas|horas|metas|aulas|videoaulas|paginas|vagas|km))/g,
];

/**
 * Fato do cargo, não preço do curso: o valor que vem logo depois destas palavras.
 * (C01, -c01.3, rodada 2) Só o PRIMEIRO valor, e a isenção acabava em palavra de oferta.
 * Antes, qualquer valor até 40 caracteres depois era isento, e "Com salário de R$ 6000, o
 * curso custa R$ 997." passava inteiro (achado 3 da 1ª revisão adversarial da -c01.3).
 *
 * (Rodada 3) A janela de 40 caracteres ainda deixava passar o preço sem palavra de
 * oferta no meio: "Com salário alto, dá 997 no Pix.", "Use parte do seu salário: R$ 997
 * à vista." (achado 5 da 2ª revisão). Agora o valor tem de vir LIGADO à expressão do
 * cargo: entre a palavra e ele, só modificador ("inicial", "base", "salarial"…), ligação
 * ("é", "fica", "de", "em torno de"…) ou a designação "de/do/da + uma palavra" ("do
 * cargo", "de técnico") — sem pontuação, sem outro número, sem verbo solto. E a frase do
 * valor não pode ter palavra de pagamento ou do curso (`PAGAMENTO_OU_CURSO`).
 */
const PALAVRA_DO_CARGO =
  '(?:salario|remuneracao|vencimentos?|piso|beneficios?|auxilio|plr|participacao nos lucros)';
const LIGACAO =
  '(?:inicial|base|basico|bruto|bruta|liquido|liquida|mensal|salarial|e|eh|sera|fica|chega|gira|vai|de|em|a|ate|torno|cerca)';
const FATO_DO_CARGO = new RegExp(
  `\\b${PALAVRA_DO_CARGO}(?: (?:${LIGACAO}|(?:de|do|da) [a-z]+)){0,6} (?:r\\$ ?)?$`,
);

/**
 * (Rodada 3) Palavra de pagamento ou do curso: na frase dela, nenhum valor é do cargo.
 * Sobre o texto sem acento. "Entrada" fica, mesmo vetando "salário de entrada de R$ …":
 * na dúvida, o valor não sai.
 */
const PAGAMENTO_OU_CURSO =
  /\b(?:pix|a vista|parcel\w*|boletos?|cartao|cartoes|entrada|descontos?|cursos?|matriculas?|planos?|custa|custam|custo|investimentos?|valor (?:do|da|dos|das)|mensalidades?|precos?|promocao|ofertas?|inscricao|pag(?:a|ar|am|amos|ando|ou|o|amento|amentos))\b/;

/** A frase do texto (sem acento) em que cai a posição `i`: o fim de frase é `.`, `!` ou `?` seguido de espaço. */
function fraseEm(t: string, i: number): string {
  const fim = /[.!?](?= |$)/g;
  let ini = 0;
  let f: RegExpExecArray | null;
  while ((f = fim.exec(t)) !== null) {
    if (f.index >= i) return t.slice(ini, f.index);
    ini = f.index + 1;
  }
  return t.slice(ini);
}

function semAcento(texto: string): string {
  return texto
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** O texto sem os links: o número dentro de um endereço não é valor. */
function semLinks(texto: string): string {
  let t = texto;
  for (const link of linksNoTexto(texto)) t = t.split(link).join(' ');
  return t;
}

/** Os trechos com valor em dinheiro do curso (vazio = nenhum). */
export function trechosDeDinheiro(body: string): string[] {
  const original = semLinks(body);
  const t = semAcento(original);
  const trechos: string[] = [];
  for (const re of FORMAS_DA_M1) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) {
      if (FATO_DO_CARGO.test(t.slice(0, m.index)) && !PAGAMENTO_OU_CURSO.test(fraseEm(t, m.index))) continue;
      trechos.push(m[0]);
    }
  }
  // O que o detector de promessas lê e a lista acima não cobre (euro, "N% off",
  // "desconto de N%", "parcelado em 12x"). Real (R$, reais, real) fica com a lista acima,
  // que lê as mesmas formas e conhece a isenção do salário.
  if (trechos.length === 0) {
    for (const p of extractPromises(original)) {
      if (p.kind === 'discount') trechos.push(`${p.value}%`);
      else if (p.kind === 'installments') trechos.push(`${p.value}x`);
      else if (p.moeda === 'EUR') trechos.push('€');
    }
  }
  return trechos;
}

export const valorEmDinheiroGate: Gate = {
  name: 'valor_em_dinheiro',
  evaluate: (ctx) => {
    if (ctx.travasDeEnvio?.valorEmDinheiro !== true) return { pass: true };
    const trechos = trechosDeDinheiro(ctx.body);
    if (trechos.length === 0) return { pass: true };
    return {
      pass: false,
      code: 'valor_em_dinheiro',
      reason: renderVetoDeDinheiro(trechos),
      detail: { trechos: trechos.length },
    };
  },
};

/** O erro de ensino: o que foi visto e o que fazer no lugar. */
export function renderVetoDeDinheiro(trechos: readonly string[]): string {
  return (
    `A mensagem NÃO foi enviada: ela escreve valor em dinheiro (${trechos
      .slice(0, 3)
      .map((t) => `"${t.trim()}"`)
      .join(', ')}). Nesta conversa, valor, parcela, juros e desconto ficam na página de ` +
    'matrícula: mande o link exato da página que a base devolver e diga que lá estão as formas de ' +
    'pagamento, sem escrever nenhum número de dinheiro.'
  );
}
