/** Contrato público sanitizado. Nenhum tipo do motor de atendimento atravessa esta fronteira. */
import { z } from "zod";
const id = z.string().min(1).max(200);
const text = z.string().max(100_000);
const optionSchema = z.object({ id, title: text, description: text.optional() });
export const fieldSchema = z.object({
  name: id,
  label: text,
  type: id,
  required: z.boolean(),
  dynamic: z.boolean(),
  options: z.array(optionSchema).max(10000),
  condition: text.optional(),
});
export const screenSchema = z.object({
  id,
  title: text,
  texts: z.array(text).max(200),
  terminal: z.boolean(),
  fields: z.array(fieldSchema).max(200),
  next: z
    .array(z.object({ target: id, label: text, verified: z.boolean(), condition: text.optional() }))
    .max(200),
});
export const flowSchema = z.object({
  id,
  name: text,
  status: z.enum(["PUBLISHED", "DRAFT", "DEPRECATED", "UNKNOWN"]),
  activation: z.enum(["enabled", "disabled", "unknown"]),
  audience: text,
  entry_screen: z.string().max(200),
  verified: z.boolean(),
  definition_hash: z.string().max(200),
  screens: z.array(screenSchema).max(500),
});
const answerSchema = z
  .object({ screen: id, data: z.record(z.string().max(200), z.json()) })
  .strict();
export const simulationRequestSchema = z
  .object({ snapshot_id: id, flow_id: id, answers: z.array(answerSchema).max(100) })
  .strict();
export const simulationResultSchema = z.object({
  snapshot_id: id,
  flow_id: id,
  steps: z
    .array(z.object({ screen: id, title: text, data: z.record(z.string(), z.json()) }))
    .max(200),
  outcome: text,
  verified: z.boolean(),
  fields: z.record(z.string(), z.json()),
});
export const snapshotSchema = z
  .object({
    schema_version: z.literal(1),
    snapshot_id: id,
    organization_id: z.uuid(),
    environment: z.enum(["production", "laboratory", "example"]),
    captured_at: z.iso.datetime({ offset: true }),
    completeness: z.enum(["complete", "partial", "unverified"]),
    sources: z
      .array(
        z.object({
          id,
          label: text,
          status: z.enum(["ok", "error", "unknown"]),
          checked_at: z.iso.datetime({ offset: true }),
          version: text.optional(),
          message: text.optional(),
        }),
      )
      .max(100),
    flows: z.array(flowSchema).max(1000),
    graph: z.object({
      nodes: z
        .array(
          z.object({
            id,
            label: text,
            kind: z.enum(["entry", "decision", "form", "agent", "human", "exit"]),
            detail: text.optional(),
            flow_id: id.optional(),
          }),
        )
        .max(1000),
      edges: z
        .array(z.object({ id, source: id, target: id, label: text, verified: z.boolean() }))
        .max(3000),
    }),
    divergences: z
      .array(
        z.object({
          id,
          severity: z.enum(["info", "warning", "error"]),
          title: text,
          detail: text,
          flow_id: id.optional(),
          screen_id: id.optional(),
        }),
      )
      .max(3000),
    scenarios: z
      .array(
        z.object({
          id,
          title: text,
          description: text,
          flow_id: id,
          answers: z.array(answerSchema).max(100),
        }),
      )
      .max(500),
    agent: z.object({ name: text, version: text, instructions: text }).optional(),
  })
  .superRefine((s, ctx) => {
    const ids = s.graph.nodes.map((n) => n.id);
    if (
      new Set(ids).size !== ids.length ||
      new Set(s.flows.map((f) => f.id)).size !== s.flows.length
    )
      ctx.addIssue({ code: "custom", message: "Identificadores duplicados na fotografia." });
    for (const edge of s.graph.edges)
      if (!ids.includes(edge.source) || !ids.includes(edge.target))
        ctx.addIssue({ code: "custom", message: "Conexão sem etapa correspondente." });
  });
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Flow = z.infer<typeof flowSchema>;
export type Screen = z.infer<typeof screenSchema>;
export type FlowField = z.infer<typeof fieldSchema>;
export type SimulationRequest = z.infer<typeof simulationRequestSchema>;
export type SimulationResult = z.infer<typeof simulationResultSchema>;
