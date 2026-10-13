"use client";
import { useT } from "@/hooks/i18n/useT";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  MarkerType,
  Position,
  ReactFlow,
  useNodesState,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { posicionar, type MapNode, type MapEdge } from "./modelo";
import styles from "./jornadas.module.css";

type EtapaData = Record<string, unknown> & {
  label: string;
  detail?: string;
  kind: string;
  highlighted: boolean;
};
type EtapaNode = Node<EtapaData, "etapa">;
const kinds: Record<string, string> = {
  entry: "Entrada",
  decision: "Condição",
  form: "Formulário",
  agent: "Agente",
  human: "Equipe",
  exit: "Destino",
};
function Etapa({ data, selected }: NodeProps<EtapaNode>) {
  const t = useT();
  return (
    <div
      className={`w-[255px] rounded-lg border bg-surface p-4 text-left text-text shadow-xs ${selected || data.highlighted ? "border-accent ring-2 ring-accent-soft" : "border-border"}`}
    >
      <Handle type="target" position={Position.Top} className="!bg-accent" />
      <p className="mb-2 text-[11px] font-medium tracking-wide text-text-muted uppercase">
        {t(kinds[data.kind] ?? "Etapa")}
      </p>
      <p className="text-sm leading-5 font-semibold break-words">{data.label}</p>
      {data.detail && (
        <p className="mt-1 line-clamp-3 text-xs leading-5 text-text-muted">{data.detail}</p>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-accent" />
    </div>
  );
}
const nodeTypes = { etapa: Etapa };
const noHighlights: string[] = [];

export default function Mapa({
  nodes,
  edges,
  selected,
  highlighted = noHighlights,
  onSelect,
}: {
  nodes: MapNode[];
  edges: MapEdge[];
  selected?: string | null;
  highlighted?: string[];
  onSelect: (id: string) => void;
}) {
  const t = useT();
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<Pick<ReactFlowInstance, "setViewport"> | null>(null);
  const focusNode = useCallback((node: EtapaNode, atStart = false) => {
    const width = container.current?.clientWidth ?? 600;
    const height = container.current?.clientHeight ?? 590;
    void instance.current?.setViewport(
      {
        x: width / 2 - (node.position.x + 127.5) * 0.9,
        y: atStart ? 24 : height / 2 - (node.position.y + 70) * 0.9,
        zoom: 0.9,
      },
      { duration: atStart ? 0 : 200 },
    );
  }, []);
  const flowNodes = useMemo<EtapaNode[]>(
    () =>
      posicionar(nodes, edges).map((node) => ({
        id: node.id,
        type: "etapa" as const,
        position: node.position,
        selected: node.id === selected,
        data: {
          label: node.label,
          detail: node.detail,
          kind: node.kind,
          highlighted: highlighted.includes(node.id),
        },
        ariaLabel: `${t(kinds[node.kind] ?? "Etapa")}: ${node.label}`,
      })),
    [nodes, edges, selected, highlighted, t],
  );
  const flowEdges = useMemo(
    () =>
      edges.map((edge) => ({
        ...edge,
        type: "smoothstep",
        markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-text-muted)" },
        style: {
          stroke: "var(--color-text-muted)",
          strokeDasharray: edge.verified ? undefined : "5 4",
        },
        labelStyle: { fill: "var(--color-text)", fontSize: 11 },
        labelBgStyle: { fill: "var(--color-surface)" },
        labelBgPadding: [6, 4] as [number, number],
      })),
    [edges],
  );
  // O minimapa precisa das medições reais devolvidas pelo React Flow.
  const [renderNodes, setRenderNodes, onNodesChange] = useNodesState(flowNodes);
  useEffect(() => {
    setRenderNodes(flowNodes);
  }, [flowNodes, setRenderNodes]);
  useEffect(() => {
    const active = flowNodes.find((node) => node.id === selected);
    if (active) focusNode(active);
  }, [selected, flowNodes, focusNode]);
  return (
    <div
      ref={container}
      className={`${styles.canvas} h-full min-h-[480px] w-full`}
      data-testid="jornadas-mapa"
    >
      <ReactFlow
        nodes={renderNodes}
        onNodesChange={onNodesChange}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onInit={(api) => {
          instance.current = api;
          const first = flowNodes.find((node) => node.id === selected) ?? flowNodes[0];
          if (first) focusNode(first, !selected);
        }}
        onNodeClick={(_, node) => onSelect(node.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            const target = event.target as HTMLElement;
            const id = target.closest(".react-flow__node")?.getAttribute("data-id");
            if (id) {
              event.preventDefault();
              onSelect(id);
            }
          }
        }}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        minZoom={0.18}
        maxZoom={1.5}
        proOptions={{ hideAttribution: false }}
        ariaLabelConfig={{
          "controls.zoomIn.ariaLabel": t("Aproximar mapa"),
          "controls.zoomOut.ariaLabel": t("Afastar mapa"),
          "controls.fitView.ariaLabel": t("Enquadrar mapa"),
          "node.a11yDescription.default": t("Pressione Enter para abrir os detalhes da etapa."),
        }}
      >
        <Background gap={22} size={1} color="var(--color-border)" />
        <Controls showInteractive={false} />
        <MiniMap
          position="top-right"
          style={{ width: 132, height: 96 }}
          pannable
          zoomable
          nodeColor="var(--color-accent)"
          maskColor="color-mix(in srgb, var(--color-bg) 60%, transparent)"
          ariaLabel={t("Minimapa do atendimento")}
        />
      </ReactFlow>
    </div>
  );
}
