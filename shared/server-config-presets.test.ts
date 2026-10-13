import { expect, it } from 'vitest';
import { builtinConfigPreset, configPresetChanges, parseConfigPresets, presetValues } from './server-config-presets';
import { minecraftModule } from '../electron/gameserver/modules/minecraft';
import type { InstanceView } from './gameserver-types';
const schema = minecraftModule.configSchema({} as InstanceView);
it('previews resource/gameplay changes without changing port, authentication or the world seed', () => {
  const current = { 'server-port': '25566', 'online-mode': 'true', 'level-seed': '123', gamemode: 'creative', 'havvn-memory-mb': '2048' };
  const values = builtinConfigPreset('modded', schema);
  expect({ ...current, ...values }).toMatchObject({ 'server-port': '25566', 'online-mode': 'true', 'level-seed': '123', gamemode: 'creative', 'havvn-memory-mb': '4096' });
  expect(configPresetChanges(current, values, schema).find(p => p.field.key === 'havvn-memory-mb')).toMatchObject({ before: '2048', after: '4096' });
  expect(presetValues({ 'havvn-memory-mb': '-1', 'server-port': '7', gamemode: 'invalid' }, schema)).toEqual({});
});
it('drops executable and network fields from custom preset storage', () => {
  const p = { id: 'custom-one', name: ' Mine ', values: { 'online-mode': 'false', 'server-port': '1', script: 'bad', gamemode: 'survival' } };
  expect(parseConfigPresets([p, p, { ...p, id: '__proto__' }])).toEqual([{ id: 'custom-one', name: 'Mine', values: { gamemode: 'survival' } }]);
});
