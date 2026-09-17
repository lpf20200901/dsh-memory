/** 注册桩解析器（Node 20+ 的 `node --import`）。 */
import { register } from 'node:module';

register('./stub-resolver.mjs', import.meta.url);
