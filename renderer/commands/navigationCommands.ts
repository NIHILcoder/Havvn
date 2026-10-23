import { createAppCommands, type CommandContext } from './appCommands';
import type { Command } from './registry';
import { validateFavorite, type NavigationFavorite } from '../../shared/navigation';

/** Shared capabilities for the palette and favorites; no saved handler, URI or IPC payload. */
export function createNavigationCommands(ctx: CommandContext): Command[] {
  const { t } = ctx, commands = createAppCommands(ctx);
  for (const view of ctx.getViews?.() ?? []) {
    const available = () => ctx.getViews?.().some(item => item.id === view.id) ? null : t('commands.missing');
    commands.push({ id: `download-view:${view.id}`, title: view.name, description: t('views.title'), keywords: [t('views.title'), 'view', view.conditions.name], group: 'views',
      disabledReason: available, run: () => {
        const reason = available(); if (reason) throw new Error(reason);
        ctx.navigate({ kind: 'download-view', id: view.id });
      } });
  }
  for (const room of ctx.getRooms()) {
    commands.push({ id: `room:${room.roomId}`, title: room.name, description: t('nav.rooms'), keywords: ['room', room.roomId], group: 'rooms',
      disabledReason: () => ctx.getRooms().some(item => item.roomId === room.roomId) ? null : t('commands.missing'),
      run: async () => {
        const live = (await ctx.api.rooms.list()).find(item => item.roomId === room.roomId);
        if (!live) throw new Error(t('commands.missing'));
        ctx.navigate({ kind: 'room', id: live.roomId });
      } });
  }
  return commands;
}

export function commandFavorite(command: Command): NavigationFavorite | null {
  const value = command.group === 'rooms' && command.id.startsWith('room:') ? { kind: 'room', id: command.id.slice(5) }
    : command.group === 'views' && command.id.startsWith('download-view:') ? { kind: 'view', id: command.id.slice(14) }
    : command.group === 'pages' || command.group === 'actions' ? { kind: 'command', id: command.id } : null;
  if (!value) return null;
  try { return validateFavorite(value); } catch { return null; }
}
