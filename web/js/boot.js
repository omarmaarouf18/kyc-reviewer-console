// Browser entry: the only file with boot side effects. Loaded with
// <script type="module" src="/js/boot.js"> (no build step, strict CSP).
import { boot } from './main.js';

boot();
