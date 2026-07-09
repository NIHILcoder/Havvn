/** Untyped CJS package (module.exports = Client). Declared so it can be a real
 *  ESM import — which lets vitest mock it — instead of a bare require(). */
declare module 'bittorrent-tracker' {
  const Client: any;
  export default Client;
}
