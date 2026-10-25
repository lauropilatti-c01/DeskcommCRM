import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AGENT_TOOL_DEFS, schemaDeEnvioDoTurno } from '@/lib/agent-engine/agent/inbound-turn';

describe('schema de envio por capacidade', () => {
  it('OFF omite apenas vídeo no schema efetivo e conserva texto/fotos', () => {
    const schema = schemaDeEnvioDoTurno(false);
    expect(Object.keys(z.toJSONSchema(schema).properties ?? {})).toEqual(['body', 'produto_codigo']);
    expect(schema.parse({ body: 'Texto.' })).toEqual({ body: 'Texto.' });
    expect(schema.parse({ body: 'Veja as fotos.', produto_codigo: 'catalogo-ficticio' }))
      .toEqual({ body: 'Veja as fotos.', produto_codigo: 'catalogo-ficticio' });
  });
  it.each(['none', '', null, undefined, 'fixture'])('OFF não apaga campo indevido para enviar só texto: %j', (video_chave) => {
    const result = schemaDeEnvioDoTurno(false).safeParse({ body: 'Não enviar como texto.', video_chave });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('O campo de vídeo foi descartado silenciosamente.');
    expect(result.error.message).toContain('somente body');
  });
  it('ON mantém o mesmo schema validado de vídeo e não altera o catálogo global', () => {
    const on = schemaDeEnvioDoTurno(true);
    expect(on).toBe(AGENT_TOOL_DEFS.send_message.inputSchema);
    schemaDeEnvioDoTurno(false);
    expect(on.parse({ body: 'Legenda.', video_chave: 'fixture' })).toEqual({ body: 'Legenda.', video_chave: 'fixture' });
    expect(z.toJSONSchema(on).properties).toHaveProperty('video_chave');
  });
});
