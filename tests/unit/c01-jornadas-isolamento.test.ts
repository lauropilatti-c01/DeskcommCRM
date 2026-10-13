import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sidebarGroups, hubSections, NAV_DESTINATIONS } from '@/lib/navigation/registry';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(file) : /\.tsx?$/.test(file) ? [file] : [];
  });
}
describe('Jornadas permanece separado do atendimento', () => {
  it('o motor e os workers não dependem do leitor ou da tela', () => {
    const forbidden = /(?:from\s*|import\s*\(|require\s*\()["'][^"']*(?:c01\/jornadas|lab\/jornadas)/;
    const leaks = [...sources('lib/agent-engine'), ...sources('workers')].filter(file => forbidden.test(readFileSync(file, 'utf8')));
    expect(leaks).toEqual([]);
  });
  it('viewer encontra o módulo ligado no menu e no hub', () => {
    const menu = sidebarGroups(false, 'viewer', undefined, ['c01_jornadas']).flatMap(g => g.items);
    const hub = hubSections('ia', false, 'viewer', undefined, ['c01_jornadas']).flatMap(g => g.items);
    expect(menu.some(item => item.href === '/app/jornadas')).toBe(true);
    expect(hub.some(item => item.href === '/app/jornadas')).toBe(true);
    expect(NAV_DESTINATIONS.find(item => item.href === '/app/jornadas')?.icon).toBeDefined();
  });
  it('módulo desligado some das duas portas mesmo para administrador', () => {
    const menu = sidebarGroups(true, 'admin', undefined, []).flatMap(g => g.items);
    const hub = hubSections('ia', true, 'admin', undefined, []).flatMap(g => g.items);
    expect([...menu, ...hub].some(item => item.href === '/app/jornadas')).toBe(false);
  });
});
