/** Local tutorial state. Never contains paths, invites, addresses or source URLs. */
export const FIRST_STEPS_KEY = 'havvn.first-steps.v1';
export const FIRST_STEP_ROUTES = ['download', 'watch', 'share', 'play'] as const;
export type FirstStepRoute = typeof FIRST_STEP_ROUTES[number];
export interface RouteProgress { prepared: boolean; done: boolean; target?: string }
export interface FirstStepsState {
  version: 1;
  seen: boolean;
  active: FirstStepRoute | null;
  routes: Record<FirstStepRoute, RouteProgress>;
}
export function emptyFirstSteps(seen = false): FirstStepsState {
  return { version: 1, seen, active: null, routes: {
    download: { prepared: false, done: false }, watch: { prepared: false, done: false },
    share: { prepared: false, done: false }, play: { prepared: false, done: false },
  } };
}
export const isFirstStepRoute = (value: unknown): value is FirstStepRoute =>
  FIRST_STEP_ROUTES.includes(value as FirstStepRoute);
export function readFirstSteps(raw: string | null, legacySeen = false): FirstStepsState {
  const state = emptyFirstSteps(legacySeen);
  if (!raw || raw.length > 4096) return state;
  try {
    const input = JSON.parse(raw);
    if (input?.version !== 1) return state;
    state.seen = legacySeen || input.seen === true;
    state.active = isFirstStepRoute(input.active) ? input.active : null;
    for (const route of FIRST_STEP_ROUTES) {
      const row = input.routes?.[route];
      state.routes[route] = { prepared: row?.prepared === true || row?.done === true, done: row?.done === true };
      if (typeof row?.target === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(row.target)) state.routes[route].target = row.target;
    }
  } catch { /* Invalid local progress is ignored, never an app startup failure. */ }
  return state;
}
