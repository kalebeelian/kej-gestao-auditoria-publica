import { Capacitor, registerPlugin } from './vendor/capacitor-core/index.js';

const KEJUpdater = registerPlugin('KEJUpdater');
window.KEJUpdater = KEJUpdater;
window.KEJUpdaterAvailable =
  Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('KEJUpdater');
window.dispatchEvent(new Event('kej-updater-ready'));
