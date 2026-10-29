import { useSyncExternalStore } from 'react';
import { createFirstStepsState } from '../state/first-steps-state';
export const FIRST_STEPS_OPEN = 'havvn:first-steps';
export const firstSteps = createFirstStepsState(() => localStorage);
export const useFirstSteps = () => useSyncExternalStore(firstSteps.subscribe, firstSteps.getSnapshot, firstSteps.getSnapshot);
export const openFirstSteps = () => window.dispatchEvent(new Event(FIRST_STEPS_OPEN));
