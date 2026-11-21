import React from 'react';
import { createPortal } from 'react-dom';
import { Modal } from '../../components/Modal';
import { useHostWindow } from '../../utils/hostWindow';

export type ToolCloseGuard = () => boolean | Promise<boolean>;
export interface EmbeddedRoomTool {
  embedded?: boolean;
  registerClose?(guard: ToolCloseGuard | null): void;
}

/** The same tool can live in a workspace tab or retain its standalone dialog. */
export function RoomToolSurface({ embedded, children, footer, ...props }: React.ComponentProps<typeof Modal> & { embedded?: boolean }) {
  const host = useHostWindow();
  if (!embedded) return createPortal(<Modal {...props} footer={footer}>{children}</Modal>, host.document.body);
  return <section className={'room-tool-surface ' + (props.className ?? '')} aria-label={typeof props.title === 'string' ? props.title : undefined} aria-busy={props.busy}>
    <div className={'room-tool-body ' + (props.bodyClassName ?? '')}>{children}</div>
    {footer && <footer className="room-tool-footer">{footer}</footer>}
  </section>;
}
