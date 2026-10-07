"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { TravaComInterruptor } from "@/lib/agent-engine/guardrails/link-e-valor-de-ferramenta";

/** (C01, -c01.7) As travas de envio que se ligam pela tela, por organização. */
export interface TravaDeEnvioDaTela {
  trava: TravaComInterruptor;
  enabled: boolean;
}

interface Resposta {
  data: { travas: TravaDeEnvioDaTela[]; podeEditar: boolean };
}

const CHAVE = ["ai", "send-guards"] as const;

export function useSendGuards() {
  return useQuery({
    queryKey: CHAVE,
    queryFn: async () => (await apiClient.get<Resposta>("/api/v1/ai/send-guards")).data,
  });
}

export function useSetSendGuard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { trava: TravaComInterruptor; enabled: boolean }) =>
      apiClient.put("/api/v1/ai/send-guards", input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: CHAVE }),
  });
}
