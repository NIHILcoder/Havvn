/**
 * Browser-guest entry. Confirm-to-join: a hash invite only prefills the gate.
 */

import { GuestApp } from './ui';

const root = document.getElementById('app');
if (root) new GuestApp(root);
