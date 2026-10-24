import { describe, expect, it } from "vitest";
import { planejarContinuacaoC01, type FatosContinuacaoC01 } from "./c01-continuacao";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = new Date("2026-10-24T15:01:00Z");
function fixture(): FatosContinuacaoC01 {
  return {
    enabled: true,
    approved: true,
    activatedAt: "2026-10-24T11:00:00Z",
    organizationId: id(1),
    contactId: id(2),
    conversationId: id(3),
    leadId: id(4),
    productKey: "ficticio",
    job: {
      id: id(5),
      organizationId: id(1),
      contactId: id(2),
      conversationId: id(3),
      kind: "inbound_turn",
      status: "done",
      createdAt: "2026-10-24T14:59:00Z",
      completedAt: "2026-10-24T15:00:30Z",
      inboundMessageId: id(6),
    },
    inbound: {
      id: id(6),
      organizationId: id(1),
      contactId: id(2),
      conversationId: id(3),
      direction: "inbound",
      body: "Quero saber como começar na área de Operação",
      at: "2026-10-24T14:59:00Z",
      revoked: false,
    },
    final: {
      id: id(7),
      jobId: id(5),
      organizationId: id(1),
      contactId: id(2),
      conversationId: id(3),
      direction: "outbound",
      externalId: "wamid.ficticio",
      sentAt: "2026-10-24T15:00:00Z",
      receipt: {
        index: 0,
        messageIds: [id(7)],
        receipts: [
          {
            id: id(7),
            status: "sent",
            delivered_at: "2026-10-24T15:00:05Z",
            read_at: null,
            error_code: null,
          },
        ],
      },
    },
    latestInboundId: id(6),
    latestOutboundId: id(7),
    human: false,
    openCase: false,
    refused: false,
    restricted: false,
    pause: false,
    purchaseReported: false,
    callback: false,
    liveSequence: false,
    offer: null,
  };
}
const proposal = {
  estado: "pendente",
  caminho: "L1",
  mensagem_entrada_id: id(6),
  trecho_do_pedido: "como começar na área de Operação",
  natureza: "informacao_solicitada",
  texto: "O cronograma ajuda a organizar o começo... se quiser, seguimos pela sua área.",
};
function offer(f: FatosContinuacaoC01) {
  f.offer = {
    enrollmentId: id(8),
    originMessageId: id(9),
    organizationId: id(1),
    contactId: id(2),
    conversationId: id(3),
    leadId: id(4),
    productKey: "ficticio",
    trusted: true,
    deliveredAt: "2026-10-24T12:00:00Z",
    touches: [],
  };
}

describe("continuação contextual proposta, com autoridade do servidor", () => {
  it("L1 antes da oferta aceita produto ausente; L2 exige a identidade exata", () => {
    const f = fixture();
    f.productKey = null;
    expect(planejarContinuacaoC01(proposal, f, now).kind).toBe("candidate");
    offer(f);
    expect(
      planejarContinuacaoC01({ ...proposal, caminho: "L2", texto: undefined }, f, now).kind,
    ).toBe("blocked");
  });
  it("L1 espera duas horas do último envio comprovado, mesmo com status sent e recibo", () => {
    expect(planejarContinuacaoC01(proposal, fixture(), now)).toMatchObject({
      kind: "candidate",
      path: "L1",
      dueAt: "2026-10-24T17:00:05.000Z",
      nextTouch: 1,
      anchorMessageId: id(7),
      idempotencyKey: `c01-continuation:${id(5)}`,
      body: proposal.texto,
    });
  });
  it("OFF e texto candidato não autorizam matrícula", () => {
    for (const key of ["enabled", "approved"] as const) {
      const f = fixture();
      f[key] = false;
      expect(planejarContinuacaoC01(proposal, f, now).kind).toBe("blocked");
    }
  });
  it("não interpreta next_action, etiqueta ou ausência de ferramenta", () => {
    for (const raw of [undefined, { next_action: "retomar em 2h" }, { tag: "pendente" }])
      expect(planejarContinuacaoC01(raw, fixture(), now).kind).toBe("blocked");
  });
  it("turno não concluído ou anterior à ativação não nasce depois", () => {
    const f = fixture();
    f.job.status = "running";
    expect(planejarContinuacaoC01(proposal, f, now).kind).toBe("blocked");
    f.job.status = "done";
    f.job.createdAt = "2026-10-23T15:00:00Z";
    expect(planejarContinuacaoC01(proposal, f, now).kind).toBe("blocked");
  });
  it("recusa vínculo cruzado de organização, conversa, contato ou job", () => {
    for (const key of ["organizationId", "contactId", "conversationId", "jobId"] as const) {
      const f = fixture();
      f.final[key] = id(99);
      expect(planejarContinuacaoC01(proposal, f, now).kind).toBe("blocked");
    }
  });
  it("recibo ausente, aceito, erro e mensagem final trocada não provam origem", () => {
    const f = fixture();
    f.final.receipt.receipts[0]!.delivered_at = null;
    expect(planejarContinuacaoC01(proposal, f, now).kind).toBe("blocked");
    f.final.receipt.receipts[0]!.delivered_at = "2026-10-24T15:00:05Z";
    f.final.receipt.receipts[0]!.error_code = "131049";
    expect(planejarContinuacaoC01(proposal, f, now).kind).toBe("blocked");
    const g = fixture();
    g.latestOutboundId = id(98);
    expect(planejarContinuacaoC01(proposal, g, now).kind).toBe("blocked");
  });
  it("pedido precisa pertencer ao inbound do turno, com trecho literal", () => {
    expect(
      planejarContinuacaoC01({ ...proposal, mensagem_entrada_id: id(99) }, fixture(), now).kind,
    ).toBe("blocked");
    expect(
      planejarContinuacaoC01(
        { ...proposal, trecho_do_pedido: "Uma dúvida inventada" },
        fixture(),
        now,
      ).kind,
    ).toBe("blocked");
  });
  it("agradecimento sozinho e pausa não viram pendência", () => {
    const f = fixture();
    f.inbound.body = "Obrigado pela ajuda!";
    expect(
      planejarContinuacaoC01({ ...proposal, trecho_do_pedido: f.inbound.body }, f, now).kind,
    ).toBe("blocked");
    expect(planejarContinuacaoC01({ estado: "pausa" }, fixture(), now).kind).toBe("blocked");
  });
  it("resposta nova, humano, caso, recusa, pagamento dito, pausa, retorno e outra sequência bloqueiam", () => {
    for (const key of [
      "human",
      "openCase",
      "refused",
      "restricted",
      "pause",
      "purchaseReported",
      "callback",
      "liveSequence",
    ] as const) {
      const f = fixture();
      f[key] = true;
      expect(planejarContinuacaoC01(proposal, f, now).kind).toBe("blocked");
    }
    const f = fixture();
    f.latestInboundId = id(99);
    expect(planejarContinuacaoC01(proposal, f, now).kind).toBe("blocked");
  });
  it("L1 não compete com oferta e não atravessa janela nem horário", () => {
    const f = fixture();
    offer(f);
    expect(planejarContinuacaoC01(proposal, f, now).kind).toBe("blocked");
    const g = fixture();
    g.final.sentAt = "2026-10-24T23:00:00Z";
    g.final.receipt.receipts[0]!.delivered_at = "2026-10-24T23:00:01Z";
    g.job.completedAt = "2026-10-24T23:00:10Z";
    expect(planejarContinuacaoC01(proposal, g, new Date("2026-10-24T23:01:00Z"))).toMatchObject({
      kind: "candidate",
      dueAt: "2026-10-25T11:00:00.000Z",
    });
    g.inbound.at = "2026-10-23T23:00:00Z";
    expect(planejarContinuacaoC01(proposal, g, new Date("2026-10-24T23:01:00Z")).kind).toBe(
      "blocked",
    );
  });
  it("L2 conserva a entrega original e usa somente o próximo toque restante", () => {
    const f = fixture();
    offer(f);
    f.offer!.touches = [
      {
        index: 1,
        messageIds: [id(10)],
        receipts: [
          {
            id: id(10),
            status: "sent",
            delivered_at: "2026-10-24T14:00:00Z",
            read_at: null,
            error_code: null,
          },
        ],
      },
    ];
    const { texto: _text, ...l2 } = { ...proposal, caminho: "L2", natureza: "decisao_da_oferta" };
    expect(planejarContinuacaoC01(l2, f, now)).toMatchObject({
      kind: "candidate",
      path: "L2",
      nextTouch: 2,
      anchorAt: "2026-10-24T12:00:00.000Z",
      anchorMessageId: id(9),
      originalEnrollmentId: id(8),
      dueAt: "2026-10-25T12:00:00.000Z",
      body: null,
    });
  });
  it("L2 sem oferta comprovada, orçamento excedido ou recibo incompleto fica bloqueada", () => {
    const { texto: _text, ...l2 } = { ...proposal, caminho: "L2", natureza: "decisao_da_oferta" };
    const f = fixture();
    expect(planejarContinuacaoC01(l2, f, now).kind).toBe("blocked");
    offer(f);
    f.offer!.productKey = "outro";
    expect(planejarContinuacaoC01(l2, f, now).kind).toBe("blocked");
    f.offer!.productKey = "ficticio";
    f.offer!.touches = [{ index: 2, messageIds: [], receipts: [] }];
    expect(planejarContinuacaoC01(l2, f, now).kind).toBe("blocked");
  });
});

it("L2 não acumula prazos vencidos em uma rajada retroativa", () => {
  const f = fixture();
  offer(f);
  f.offer!.deliveredAt = "2026-10-10T12:00:00Z";
  expect(planejarContinuacaoC01({ ...proposal, caminho: "L2", texto: undefined }, f, now)).toEqual({
    kind: "blocked",
    reason: "orcamento_vencido_sem_intervalo",
  });
});
it("recibo futuro não comprova orçamento já entregue", () => {
  const f = fixture();
  offer(f);
  f.offer!.touches = [
    {
      index: 1,
      messageIds: [id(10)],
      receipts: [
        {
          id: id(10),
          status: "delivered",
          delivered_at: "2026-10-25T12:00:00Z",
          read_at: null,
          error_code: null,
        },
      ],
    },
  ];
  expect(planejarContinuacaoC01({ ...proposal, caminho: "L2", texto: undefined }, f, now)).toEqual({
    kind: "blocked",
    reason: "orcamento_ou_recibos_invalidos",
  });
});
