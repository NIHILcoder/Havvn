/** Windows may need tens of seconds to create the adapter, routes and rules.
 * The engine must await the helper's ready frame before announcing participation;
 * the main-process request must outlive that wait so it receives the real result. */
export const LAN_HELPER_SETUP_TIMEOUT_MS = 90_000;
// The pipe connect budget is 20 seconds; leave another 10 for command delivery.
export const LAN_START_TIMEOUT_MS = LAN_HELPER_SETUP_TIMEOUT_MS + 30_000;
