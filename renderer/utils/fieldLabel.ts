import { createContext, useContext } from 'react';
export const FieldLabelContext = createContext<{ labelId: string; descriptionId?: string } | null>(null);
export const useFieldLabel = () => useContext(FieldLabelContext);
