import { expect, it } from 'vitest';
import { pluginNetworkError } from './provider-network';
it('accepts only known structured errors without leaking raw details', () => {
  expect(pluginNetworkError('HAVVN_DIAGNOSTIC {"code":"dns","secret":"hidden"}')?.code).toBe('dns');
  expect(pluginNetworkError('HAVVN_DIAGNOSTIC {"code":"captcha"}')?.code).toBe('captcha');
  expect(pluginNetworkError('HAVVN_DIAGNOSTIC {"code":"auth","secret":"hidden"}')?.message).not.toContain('hidden');
  for (const raw of ['network: dns', 'HAVVN_DIAGNOSTIC {', 'HAVVN_DIAGNOSTIC {"code":"unknown"}', 'HAVVN_DIAGNOSTIC '+ 'x'.repeat(300)]) expect(pluginNetworkError(raw)).toBeNull();
});
