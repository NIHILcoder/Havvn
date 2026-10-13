import React, { useEffect, useRef } from 'react';
import './SelectionCheckbox.css';

interface Props extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  indeterminate?: boolean;
}

export function SelectionMarker({ checked, indeterminate = false }: { checked: boolean; indeterminate?: boolean }) {
  return <span className="selection-checkbox-mark" data-state={indeterminate ? 'mixed' : checked ? 'checked' : 'empty'} aria-hidden="true" />;
}

/** Native checkbox interaction with the same round marker used in room files. */
export function SelectionCheckbox({ indeterminate = false, className = '', ...props }: Props) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (input.current) input.current.indeterminate = indeterminate; }, [indeterminate]);
  return (
    <span className={'selection-checkbox ' + className}>
      <input {...props} ref={input} type="checkbox" aria-checked={indeterminate ? 'mixed' : props.checked} />
      <SelectionMarker checked={!!props.checked} indeterminate={indeterminate} />
    </span>
  );
}
